import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../src/lib/server';

const mocks = vi.hoisted(() => ({ getProvider: vi.fn(), cleanup: vi.fn() }));

vi.mock('../../../src/lib/providers', () => ({ getProvider: mocks.getProvider }));
vi.mock('../../../src/lib/server/cleanup', () => ({ cleanup: mocks.cleanup }));

function fakeProvider() {
  const provider = {
    name: 's3' as const,
    save: vi.fn(async () => undefined),
    get: vi.fn(),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  };
  mocks.getProvider.mockReturnValue(provider);
  return provider;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('createServer', () => {
  it.each([
    ['/', { ok: true }],
    ['/v8/artifacts/status', { ok: true, status: 'enabled' }],
  ])('responds to GET %s', async (url, body) => {
    const response = await createServer().inject({ method: 'GET', url });
    expect(response.json()).toEqual(body);
  });

  it.each(['/v2/user', '/v2/teams', '/v5/user/tokens/current'])(
    'answers the turbo login endpoint %s',
    async (url) => {
      const response = await createServer().inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
    },
  );

  it('stores uploaded artifacts with their tag', async () => {
    const provider = fakeProvider();

    const response = await createServer().inject({
      method: 'PUT',
      url: '/v8/artifacts/abc',
      headers: { 'content-type': 'application/octet-stream', 'x-artifact-tag': 'tag' },
      payload: Buffer.from('data'),
    });

    expect(response.json()).toEqual({ ok: true });
    expect(provider.save).toHaveBeenCalledWith(
      expect.anything(),
      'abc',
      'tag',
      expect.any(Readable),
    );
  });

  it('stores uploaded artifacts without a tag', async () => {
    const provider = fakeProvider();

    await createServer().inject({
      method: 'PUT',
      url: '/v8/artifacts/abc',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('data'),
    });

    expect(provider.save).toHaveBeenCalledWith(
      expect.anything(),
      'abc',
      '',
      expect.anything(),
    );
  });

  it('serves stored artifacts with size and tag headers', async () => {
    const provider = fakeProvider();
    provider.get.mockResolvedValue([5, Readable.from([Buffer.from('hello')]), 'tag']);

    const response = await createServer().inject({
      method: 'GET',
      url: '/v8/artifacts/abc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('hello');
    expect(response.headers['content-length']).toBe('5');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['x-artifact-tag']).toBe('tag');
  });

  it('omits the tag header for untagged artifacts', async () => {
    const provider = fakeProvider();
    provider.get.mockResolvedValue([
      undefined,
      Readable.from([Buffer.from('hello')]),
      undefined,
    ]);

    const response = await createServer().inject({
      method: 'GET',
      url: '/v8/artifacts/abc',
    });

    expect(response.body).toBe('hello');
    expect(response.headers['x-artifact-tag']).toBeUndefined();
  });

  it('returns 404 for unknown artifacts', async () => {
    const provider = fakeProvider();
    provider.get.mockResolvedValue(null);

    const response = await createServer().inject({
      method: 'GET',
      url: '/v8/artifacts/abc',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false });
  });

  describe('/ping', () => {
    it('reports every provider operation that worked', async () => {
      const provider = fakeProvider();
      provider.get.mockResolvedValue([1, Readable.from(['x']), undefined]);

      const response = await createServer().inject({ method: 'GET', url: '/ping' });

      expect(response.json()).toMatchObject({
        ok: true,
        tests: ['upload', 'retrieve', 'delete'],
      });
    });

    it('passes when the provider cannot delete', async () => {
      const provider = fakeProvider();
      provider.get.mockResolvedValue([1, Readable.from(['x']), undefined]);
      provider.delete.mockRejectedValue(new Error('not supported'));

      const response = await createServer().inject({ method: 'GET', url: '/ping' });

      expect(response.json()).toMatchObject({ ok: true, tests: ['upload', 'retrieve'] });
    });

    it('fails when the uploaded file cannot be retrieved', async () => {
      const provider = fakeProvider();
      provider.get.mockResolvedValue(null);

      const response = await createServer().inject({ method: 'GET', url: '/ping' });

      expect(response.json()).toEqual({
        ok: false,
        error: 'Failed to retrieve test file from cache',
      });
    });
  });

  it('runs cleanup and exits on /shutdown', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.cleanup.mockResolvedValue(undefined);

    const response = await createServer().inject({ method: 'DELETE', url: '/shutdown' });

    expect(response.json()).toEqual({ ok: true });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Average time taken:', {
      save: '0ms (0%)',
      get: '0ms (0%)',
      delete: '0ms (0%)',
      list: '0ms (0%)',
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('still exits when cleanup fails', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.cleanup.mockRejectedValue(new Error('Invalid max-age provided'));

    const response = await createServer().inject({ method: 'DELETE', url: '/shutdown' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: 'Invalid max-age provided' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});

describe('server', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'turbogha-server-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('listens on an OS-assigned port and writes it to the port file', async () => {
    vi.stubEnv('SERVER_PORT', '0');
    vi.stubEnv('RUNNER_TEMP', tempDir);
    vi.resetModules();
    const { server } = await import('../../../src/lib/server');

    const fastify = await server();
    try {
      const port = Number(readFileSync(join(tempDir, 'turbogha-port'), 'utf8'));
      expect(port).toBeGreaterThan(0);
      const response = await fetch(`http://localhost:${port}/`);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await fastify.close();
    }
  });
});
