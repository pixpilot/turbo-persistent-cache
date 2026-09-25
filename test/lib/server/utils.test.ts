/**
 * readActualPort accepts optional overrides for serverPort and serverPortFile,
 * so most tests exercise the real export directly without module mocking.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseFileSize,
  readActualPort,
  readActualPortAsync,
} from '../../../src/lib/server/utils';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'turbogha-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('wait-on');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.resetModules();
});

async function loadUtils(env: Record<string, string | undefined>) {
  vi.stubEnv('RUNNER_TEMP', tempDir);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const actionsCore = await import('@actions/core');
  const utils = await import('../../../src/lib/server/utils');
  return { actionsCore, ...utils };
}

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function close(server: Server): Promise<void> {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

describe('readActualPort', () => {
  it('returns serverPort directly when it is not 0', () => {
    expect(readActualPort(5000, 41230, join(tempDir, 'turbogha-port'))).toBe(41230);
  });

  it('reads the port from the port file when serverPort is 0', () => {
    const portFile = join(tempDir, 'turbogha-port');
    writeFileSync(portFile, '54321');
    expect(readActualPort(5000, 0, portFile)).toBe(54321);
  });

  it('throws when port file does not appear within timeout', () => {
    expect(() => readActualPort(200, 0, join(tempDir, 'turbogha-port-missing'))).toThrow(
      /Timed out waiting for server to write its port/u,
    );
  });

  it.each([
    ['invalid content', 'not-a-number'],
    ['zero', '0'],
  ])('ignores a port file with %s', (_label, content) => {
    const portFile = join(tempDir, 'turbogha-port');
    writeFileSync(portFile, content);
    expect(() => readActualPort(200, 0, portFile)).toThrow(
      /Timed out waiting for server to write its port/u,
    );
  });

  it('handles whitespace around port number', () => {
    const portFile = join(tempDir, 'turbogha-port');
    writeFileSync(portFile, '  12345\n');
    expect(readActualPort(5000, 0, portFile)).toBe(12345);
  });

  it('sleeps between polls instead of spinning', () => {
    const wait = vi.spyOn(Atomics, 'wait');
    expect(() => readActualPort(120, 0, join(tempDir, 'missing'))).toThrow();
    expect(wait.mock.calls.length).toBeGreaterThan(0);
    expect(wait.mock.calls.length).toBeLessThan(10);
  });
});

describe('readActualPortAsync', () => {
  it('returns serverPort directly when it is not 0', async () => {
    await expect(
      readActualPortAsync(5000, 41230, join(tempDir, 'turbogha-port')),
    ).resolves.toBe(41230);
  });

  it('does not block the event loop while waiting for the port file', async () => {
    const portFile = join(tempDir, 'turbogha-port');
    const portPromise = readActualPortAsync(1000, 0, portFile);

    setTimeout(() => {
      writeFileSync(portFile, '54321');
    }, 0);

    await expect(portPromise).resolves.toBe(54321);
  });

  it('throws when port file does not appear within timeout', async () => {
    await expect(
      readActualPortAsync(100, 0, join(tempDir, 'turbogha-port-missing')),
    ).rejects.toThrow(/Timed out waiting for server to write its port/u);
  });
});

describe('parseFileSize', () => {
  it.each([
    ['100b', 100],
    ['10kb', 10 * 1024],
    ['5mb', 5 * 1024 * 1024],
    ['2gb', 2 * 1024 * 1024 * 1024],
    ['1tb', 1024 * 1024 * 1024 * 1024],
    ['3 mb', 3 * 1024 * 1024],
  ])('parses %s to %d', (input, expected) => {
    expect(parseFileSize(input)).toBe(expected);
  });

  it('is case insensitive', () => {
    expect(parseFileSize('10MB')).toBe(10 * 1024 * 1024);
  });

  it('throws on invalid format', () => {
    expect(() => parseFileSize('invalid')).toThrow('Invalid file size format');
  });

  it.each(['10xx', '10constructor'])('throws on invalid unit %s', (input) => {
    expect(() => parseFileSize(input)).toThrow('Invalid file size unit');
  });
});

describe('waitForServer', () => {
  it('resolves once the server answers', async () => {
    const { server, port } = await listen();
    try {
      const { waitForServer } = await loadUtils({ CI: 'false' });
      await expect(waitForServer(port)).resolves.toBeUndefined();
    } finally {
      await close(server);
    }
  });

  it('reports the server logs when the server never comes up', async () => {
    vi.doMock('wait-on', () => ({
      default: vi.fn(async () => Promise.reject(new Error('timeout'))),
    }));
    writeFileSync(join(tempDir, 'turbogha.log'), 'listen EADDRINUSE');
    const { actionsCore, waitForServer } = await loadUtils({ CI: 'true' });

    await expect(waitForServer(1234)).rejects.toThrow('timeout');

    expect(actionsCore.error).toHaveBeenCalledWith(
      expect.stringContaining('Timed out waiting for cache server on port 1234'),
    );
    expect(actionsCore.error).toHaveBeenCalledWith(
      expect.stringContaining('listen EADDRINUSE'),
    );
  });

  it('says when there is no server log file', async () => {
    vi.doMock('wait-on', () => ({
      default: vi.fn(async () => Promise.reject(new Error('timeout'))),
    }));
    const { actionsCore, waitForServer } = await loadUtils({ CI: 'true' });

    await expect(waitForServer(1234)).rejects.toThrow('timeout');

    expect(actionsCore.error).toHaveBeenCalledWith(
      expect.stringContaining('Server log file not found'),
    );
  });
});

describe('launchServer', () => {
  it('prints the turbo environment in dev mode', async () => {
    const { server, port } = await listen();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { launchServer } = await loadUtils({
        CI: 'false',
        SERVER_PORT: String(port),
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await launchServer(true);

      expect(log).toHaveBeenCalledWith(`export TURBO_API=http://localhost:${port}`);
      expect(log).toHaveBeenCalledWith('export TURBO_TOKEN=turbogha');
    } finally {
      await close(server);
    }
  });

  it('spawns a detached server and exports the turbo environment', async () => {
    const spawn = vi.fn(() => ({ unref: vi.fn(), pid: 123 }));
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      openSync: vi.fn(() => 99),
    }));
    const { server, port } = await listen();
    try {
      const { actionsCore, launchServer } = await loadUtils({
        CI: 'true',
        SERVER_PORT: String(port),
      });

      await launchServer();

      expect(spawn).toHaveBeenCalledWith(process.argv[0], [process.argv[1], '--server'], {
        detached: true,
        stdio: ['ignore', 99, 99],
      });
      expect(actionsCore.exportVariable).toHaveBeenCalledWith(
        'TURBOGHA_PORT',
        String(port),
      );
      expect(actionsCore.exportVariable).toHaveBeenCalledWith(
        'TURBO_API',
        `http://localhost:${port}`,
      );
      expect(actionsCore.exportVariable).toHaveBeenCalledWith('TURBO_TOKEN', 'turbogha');
      expect(actionsCore.exportVariable).toHaveBeenCalledWith('TURBO_TEAM', 'turbogha');
    } finally {
      await close(server);
    }
  });
});

describe('killServer', () => {
  it('asks the server to shut down and removes the port file', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    const portFile = join(tempDir, 'turbogha-port');
    writeFileSync(portFile, '4321');
    const { killServer } = await loadUtils({ CI: 'false', SERVER_PORT: '4321' });

    await killServer();

    expect(fetch).toHaveBeenCalledWith('http://localhost:4321/shutdown', {
      method: 'DELETE',
    });
    expect(existsSync(portFile)).toBe(false);
  });
});
