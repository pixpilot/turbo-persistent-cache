import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadPing() {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('SERVER_PORT', '4321');
  vi.resetModules();
  const { ping } = await import('../../src/lib/ping');
  return ping;
}

function stubFetch(body: unknown) {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ping', () => {
  it('reports the tests the server performed', async () => {
    const fetch = stubFetch({ ok: true, tests: ['upload', 'retrieve'] });
    const ping = await loadPing();

    await expect(ping()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:4321/ping',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(console.log).toHaveBeenCalledWith(
      ' INFO ',
      'Tests performed: upload, retrieve',
    );
  });

  it('fails when the provider test failed', async () => {
    stubFetch({ ok: false, error: 'bucket missing' });
    const ping = await loadPing();

    await expect(ping()).rejects.toThrow('bucket missing');
  });

  it('fails when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const ping = await loadPing();

    await expect(ping()).rejects.toThrow('ECONNREFUSED');
  });
});
