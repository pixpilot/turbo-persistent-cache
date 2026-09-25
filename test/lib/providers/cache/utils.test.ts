import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Skip the real 1s back-off when retrying rate-limited requests.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));

const TAG = 's43Vqe9K4fqUlFo3c/2drvp46vUGR8lLgb+28BwGUJM=';

let tempDir: string;

async function load(env: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string | undefined> = {
    CI: 'false',
    ACTIONS_CACHE_URL: 'https://example.com',
    ACTIONS_RUNTIME_TOKEN: 'token',
    RUNNER_TEMP: tempDir,
    CACHE_PREFIX: undefined,
    USE_RELATIVE_CACHE_PATH: undefined,
  };
  for (const [name, value] of Object.entries({ ...defaults, ...env })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const actionsCache = await import('@actions/cache');
  const { getCacheClient } = await import('../../../../src/lib/providers/cache/utils');
  return {
    restoreCache: vi.mocked(actionsCache.restoreCache),
    saveCache: vi.mocked(actionsCache.saveCache),
    getCacheClient,
  };
}

describe('getCacheClient', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'turbogha-cache-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('requires the cache API environment variables', async () => {
    const { getCacheClient } = await load({ ACTIONS_CACHE_URL: undefined });
    expect(() => getCacheClient()).toThrow('Cache API env vars are not set');
  });

  it('queries restore keys with prefix matching for tagged cache entries', async () => {
    const { restoreCache, getCacheClient } = await load();
    restoreCache.mockResolvedValue(undefined);

    const cacheKey = 'turbogha_abc123';
    const restorationPath = join(tempDir, 'cache-turbogha_abc123.tg.bin');

    await getCacheClient().restore(restorationPath, cacheKey);

    expect(restoreCache).toHaveBeenCalledWith([restorationPath], cacheKey, [cacheKey]);
  });

  it('uploads tagged artifacts using a filesystem-safe unique temp path', async () => {
    const { saveCache, getCacheClient } = await load();
    saveCache.mockResolvedValue(1);

    const key = `turbogha_7ee20327ec1a3d63#${TAG}`;
    const encodedTag = Buffer.from(TAG, 'utf8').toString('base64url');
    const expectedTempPath = join(
      tempDir,
      `cache-turbogha_7ee20327ec1a3d63--${encodedTag}.tg.bin`,
    );

    await getCacheClient().save(key, Readable.from(Buffer.from('artifact-bytes')));

    expect(saveCache).toHaveBeenCalledWith([expectedTempPath], key);
    expect(existsSync(expectedTempPath)).toBe(false);
  });

  it('rethrows upload failures and removes the temp file', async () => {
    const { saveCache, getCacheClient } = await load();
    saveCache.mockRejectedValue(new Error('upload failed'));

    await expect(
      getCacheClient().save('turbogha_abc', Readable.from(Buffer.from('bytes'))),
    ).rejects.toThrow('upload failed');
    expect(existsSync(join(tempDir, 'cache-turbogha_abc.tg.bin'))).toBe(false);
  });

  it('retries once when rate limited', async () => {
    const { restoreCache, getCacheClient } = await load();
    restoreCache
      .mockRejectedValueOnce(new Error('Request failed with status 429'))
      .mockResolvedValueOnce('turbogha_abc');

    await expect(
      getCacheClient().restore(join(tempDir, 'x.tg.bin'), 'turbogha_abc'),
    ).resolves.toBe('turbogha_abc');
    expect(restoreCache).toHaveBeenCalledTimes(2);
  });

  it('treats a second rate limit as a cache miss', async () => {
    const { restoreCache, getCacheClient } = await load();
    restoreCache.mockRejectedValue(new Error('Rate limit exceeded'));

    await expect(
      getCacheClient().restore(join(tempDir, 'x.tg.bin'), 'turbogha_abc'),
    ).resolves.toBeUndefined();
    expect(restoreCache).toHaveBeenCalledTimes(2);
  });

  it('rethrows other restore errors', async () => {
    const { restoreCache, getCacheClient } = await load();
    restoreCache.mockRejectedValue(new Error('network down'));

    await expect(
      getCacheClient().restore(join(tempDir, 'x.tg.bin'), 'turbogha_abc'),
    ).rejects.toThrow('network down');
    expect(restoreCache).toHaveBeenCalledTimes(1);
  });

  it('passes a relative path from the temp directory when use-relative-cache-path is on', async () => {
    const { saveCache, restoreCache, getCacheClient } = await load({
      USE_RELATIVE_CACHE_PATH: 'true',
    });
    const cwdBefore = process.cwd();
    const cwdDuringCalls: string[] = [];
    saveCache.mockImplementation(async () => {
      cwdDuringCalls.push(realpathSync(process.cwd()));
      return 1;
    });
    restoreCache.mockImplementation(async () => {
      cwdDuringCalls.push(realpathSync(process.cwd()));
      return undefined;
    });
    const client = getCacheClient();
    const restorePath = join(tempDir, 'cache-turbogha_abc.tg.bin');

    await client.save('turbogha_abc', Readable.from(Buffer.from('bytes')));
    await client.restore(restorePath, 'turbogha_abc');

    expect(saveCache).toHaveBeenCalledWith(['cache-turbogha_abc.tg.bin'], 'turbogha_abc');
    expect(restoreCache).toHaveBeenCalledWith([basename(restorePath)], 'turbogha_abc', [
      'turbogha_abc',
    ]);
    expect(cwdDuringCalls).toEqual([realpathSync(tempDir), realpathSync(tempDir)]);
    expect(process.cwd()).toBe(cwdBefore);
  });
});
