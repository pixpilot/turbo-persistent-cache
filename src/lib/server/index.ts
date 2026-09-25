import type { FastifyInstance } from 'fastify';
import type { Tracker } from '../tracker';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { serverPort, serverPortFile } from '../constants';
import { getProvider } from '../providers';
import { getTracker } from '../tracker';
import { cleanup } from './cleanup';

const HTTP_NOT_FOUND = 404;
//* Delay before exiting so the shutdown response can be flushed
const SHUTDOWN_EXIT_DELAY_MS = 100;
const PERCENT = 100;

export interface RequestContext {
  log: {
    info: (message: string) => void;
  };
}

function formatShare(value: number, total: number): string {
  return `${value}ms (${Math.round((value / Math.max(total, 1)) * PERCENT)}%)`;
}

/**
 * Creates the cache server with all routes registered, without listening.
 */
export function createServer(tracker: Tracker = getTracker()): FastifyInstance {
  //* Create the server
  const fastify = Fastify({
    logger: process.env.LOG_LEVEL === 'debug',
  });

  // ? Server status check
  fastify.get('/', async () => ({ ok: true }));

  // ? Ping endpoint to test cache provider functionality
  fastify.get('/ping', async (request) => {
    request.log.info('Ping endpoint called - testing cache provider functionality');

    try {
      const tests: string[] = [];
      const provider = getProvider(tracker);
      const testHash = 'ping-test-file';
      const testContent = 'This is a test file for ping functionality';

      // Create a readable stream from the test content
      const testStream = new Readable();
      testStream.push(testContent);
      testStream.push(null); // End the stream

      // Test 1: Upload a test file
      request.log.info('Testing cache upload...');
      await provider.save(request, testHash, 'ping-test', testStream);
      request.log.info('Cache upload test successful');
      tests.push('upload');

      // Test 2: Retrieve the test file
      request.log.info('Testing cache retrieval...');
      const result = await provider.get(request, testHash);
      if (!result) {
        throw new Error('Failed to retrieve test file from cache');
      }
      request.log.info('Cache retrieval test successful');
      tests.push('retrieve');

      // Test 3: Delete the test file (only if supported)
      try {
        request.log.info('Testing cache deletion...');
        await provider.delete(testHash);
        request.log.info('Cache deletion test successful');
        tests.push('delete');
      } catch (deleteError) {
        request.log.info(
          `Cache deletion not supported or failed: ${String(deleteError)}`,
        );
        // Don't fail the ping test if deletion is not supported
      }

      return {
        ok: true,
        message: 'Cache provider functionality test completed successfully',
        tests,
      };
    } catch (error) {
      request.log.error(`Ping test failed: ${String(error)}`);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ? Shut down the server
  const shutdown = async (ctx: RequestContext): Promise<{ ok: boolean }> => {
    try {
      //* Handle cleanup
      await cleanup(ctx, tracker);
    } finally {
      //* Print tracker
      const total = tracker.save + tracker.get + tracker.delete + tracker.list;
      // eslint-disable-next-line no-console
      console.log('Average time taken:', {
        save: formatShare(tracker.save, total),
        get: formatShare(tracker.get, total),
        delete: formatShare(tracker.delete, total),
        list: formatShare(tracker.list, total),
      });

      //* Exit after responding, even when cleanup failed, so no server is left running
      setTimeout(() => process.exit(0), SHUTDOWN_EXIT_DELAY_MS);
    }
    return { ok: true };
  };
  fastify.delete('/shutdown', async (request) => shutdown(request));

  // ? Handle streaming requets body
  // https://www.fastify.io/docs/latest/Reference/ContentTypeParser/#catch-all
  fastify.addContentTypeParser('application/octet-stream', (_req, _payload, done) => {
    done(null);
  });

  // ? Upload cache
  fastify.put('/v8/artifacts/:hash', async (request) => {
    const { hash } = request.params as { hash: string };
    request.log.info(`Received artifact for ${hash}`);
    const provider = getProvider(tracker);
    const artifactTag = request.headers['x-artifact-tag'];
    await provider.save(
      request,
      hash,
      typeof artifactTag === 'string' ? artifactTag : '',
      request.raw,
    );
    request.log.info(`Saved artifact for ${hash}`);
    return { ok: true };
  });

  // ? Download cache
  fastify.get('/v8/artifacts/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    request.log.info(`Requested artifact for ${hash}`);
    const provider = getProvider(tracker);
    const result = await provider.get(request, hash);
    if (result === null) {
      request.log.info(`Artifact for ${hash} not found`);
      reply.code(HTTP_NOT_FOUND);
      return { ok: false };
    }
    const [size, stream, artifactTag] = result;
    if (size !== undefined && size !== 0) {
      reply.header('Content-Length', size);
    }
    reply.header('Content-Type', 'application/octet-stream');
    if (artifactTag !== undefined && artifactTag !== '') {
      reply.header('x-artifact-tag', artifactTag);
    }
    request.log.info(`Sending artifact for ${hash}`);
    return reply.send(stream);
  });

  /**
   *  Login and link commands
   */

  fastify.get('/v5/user/tokens/current', async () => ({
    ok: true,
    token: {
      id: 'turbogha',
      name: 'turbogha',
      type: 'turbogha',
      origin: 'turbogha',
      scopes: [],
      activeAt: Date.now(),
      createdAt: Date.now(),
    },
  }));

  fastify.get('/v8/artifacts/status', async () => ({
    ok: true,
    status: 'enabled',
  }));

  fastify.get('/v2/user', async () => ({
    ok: true,
    user: {
      id: 'turbogha',
      username: 'turbogha',
      email: 'turbogha@turbogha.com',
      name: 'turbogha',
      createdAt: Date.now(),
    },
  }));

  fastify.get('/v2/teams', async () => ({
    ok: true,
    teams: [
      {
        id: 'turbogha',
        slug: 'turbogha',
        name: 'turbogha',
        createdAt: Date.now(),
        created: new Date(),
        membership: {
          role: 'OWNER',
        },
      },
    ],
  }));

  return fastify;
}

/**
 * Starts the cache server and writes the bound port to the port file.
 */
export async function server(): Promise<FastifyInstance> {
  const fastify = createServer();

  //* Start the server
  await fastify.listen({ port: serverPort });

  //* Write the actual port to a file so the parent process can discover it
  const address = fastify.server.address();
  const actualPort =
    address !== null && typeof address === 'object' ? address.port : serverPort;
  if (actualPort <= 0) {
    throw new Error(
      `Server bound but resolved port is ${actualPort} — ` +
        `fastify.server.address() returned ${JSON.stringify(address)}`,
    );
  }
  writeFileSync(serverPortFile, String(actualPort));
  return fastify;
}
