import type { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable as NodeReadable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTracker } from '../../../../src/lib/tracker';

let tempDir: string;

async function readAll(stream: Readable | ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function load(cacheApiAvailable: boolean) {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('RUNNER_TEMP', tempDir);
  vi.stubEnv('ACTIONS_CACHE_URL', cacheApiAvailable ? 'https://example.com' : undefined);
  vi.stubEnv('ACTIONS_RUNTIME_TOKEN', cacheApiAvailable ? 'token' : undefined);
  vi.stubEnv('CACHE_PREFIX', undefined);
  vi.stubEnv('USE_RELATIVE_CACHE_PATH', undefined);
  vi.resetModules();
  const { restoreCache, saveCache } = await import('@actions/cache');
  const actionsCache = {
    restoreCache: vi.mocked(restoreCache),
    saveCache: vi.mocked(saveCache),
  };
  const provider = await import('../../../../src/lib/providers/cache');
  const constants = await import('../../../../src/lib/constants');
  return { actionsCache, provider, constants };
}

const ctx = { log: { info: vi.fn() } };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'turbogha-provider-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('filesystem fallback (no cache API)', () => {
  it('saves artifacts to RUNNER_TEMP and reads them back', async () => {
    const { provider } = await load(false);

    await provider.saveCache(ctx, 'abc', 'tag', NodeReadable.from(Buffer.from('data')));

    expect(existsSync(join(tempDir, 'abc.tg.bin'))).toBe(true);
    const result = await provider.getCache(ctx, 'abc');
    expect(result).not.toBeNull();
    const [size, stream, tag] = result!;
    expect(size).toBe(4);
    expect(tag).toBeUndefined();
    await expect(readAll(stream)).resolves.toBe('data');
  });

  it('returns null for unknown artifacts', async () => {
    const { provider } = await load(false);
    await expect(provider.getCache(ctx, 'missing')).resolves.toBeNull();
  });
});

describe('gitHub cache API', () => {
  it('saves artifacts under a tagged cache key', async () => {
    const { actionsCache, provider, constants } = await load(true);
    actionsCache.saveCache.mockResolvedValue(1);

    await provider.saveCache(ctx, 'abc', 'tag', NodeReadable.from(Buffer.from('data')));

    expect(actionsCache.saveCache).toHaveBeenCalledWith(
      [constants.getTempCachePath('turbogha_abc#tag')],
      'turbogha_abc#tag',
    );
  });

  it('restores artifacts and their tag', async () => {
    const { actionsCache, provider } = await load(true);
    actionsCache.restoreCache.mockImplementation(async ([path]: string[]) => {
      writeFileSync(path, 'cached');
      return 'turbogha_abc#tag';
    });

    const result = await provider.getCache(ctx, 'abc');

    expect(result).not.toBeNull();
    const [size, stream, tag] = result!;
    expect(size).toBe(6);
    expect(tag).toBe('tag');
    await expect(readAll(stream)).resolves.toBe('cached');
  });

  it('returns null on a cache miss', async () => {
    const { actionsCache, provider } = await load(true);
    actionsCache.restoreCache.mockResolvedValue(undefined);

    await expect(provider.getCache(ctx, 'abc')).resolves.toBeNull();
  });

  it('returns null when the restored key belongs to another hash', async () => {
    const { actionsCache, provider } = await load(true);
    actionsCache.restoreCache.mockResolvedValue('turbogha_abcdef#tag');

    await expect(provider.getCache(ctx, 'abc')).resolves.toBeNull();
  });
});

describe('getGithubProvider', () => {
  it('cannot delete or list GitHub cache entries', async () => {
    const { provider } = await load(true);
    const github = provider.getGithubProvider(getTracker());

    expect(github.name).toBe('github');
    await expect(github.delete('key')).rejects.toThrow('Cannot delete github cache');
    await expect(github.list()).rejects.toThrow('Cannot list github cache');
  });
});
