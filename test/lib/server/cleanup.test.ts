import type { TProvider } from '../../../src/lib/providers';
import type { TListFile } from '../../../src/lib/server/cleanup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '../../../src/lib/server/cleanup';
import { getTracker } from '../../../src/lib/tracker';

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }));

vi.mock('../../../src/lib/providers', () => ({ getProvider: mocks.getProvider }));

const DAY_MS = 24 * 60 * 60 * 1000;

function file(path: string, ageDays: number, size = 1): TListFile {
  return { path, createdAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(), size };
}

function fakeProvider(files: TListFile[], overrides: Partial<TProvider> = {}) {
  const provider = {
    name: 's3' as const,
    save: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => files),
    ...overrides,
  };
  mocks.getProvider.mockReturnValue(provider);
  return provider;
}

function deletedPaths(provider: Pick<TProvider, 'delete'>): string[] {
  return vi.mocked(provider.delete).mock.calls.map(([path]) => path);
}

function setOptions(options: { maxAge?: string; maxFiles?: string; maxSize?: string }) {
  vi.stubEnv('MAX_AGE', options.maxAge);
  vi.stubEnv('MAX_FILES', options.maxFiles);
  vi.stubEnv('MAX_SIZE', options.maxSize);
}

const ctx = { log: { info: vi.fn() } };

beforeEach(() => {
  setOptions({});
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('cleanup', () => {
  it('does nothing without cleanup options', async () => {
    await cleanup(ctx, getTracker());

    expect(ctx.log.info).toHaveBeenCalledWith(
      'No cleanup options provided, skipping cleanup',
    );
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it.each([
    [{ maxAge: 'soon' }, 'Invalid max-age provided'],
    [{ maxAge: '0d' }, 'Invalid max-age provided'],
    [{ maxFiles: 'many' }, 'Invalid max-files provided'],
    [{ maxFiles: '0' }, 'Invalid max-files provided'],
    [{ maxSize: 'big' }, 'Invalid file size format'],
  ])('rejects invalid options %o', async (options, message) => {
    setOptions(options);
    await expect(cleanup(ctx, getTracker())).rejects.toThrow(message);
  });

  it('is not available for the GitHub provider', async () => {
    setOptions({ maxAge: '1d' });
    fakeProvider([], { name: 'github' });

    await expect(cleanup(ctx, getTracker())).rejects.toThrow(
      'Cleanup options are not available when using the GitHub provider',
    );
  });

  it('stops when the provider cannot list files', async () => {
    setOptions({ maxAge: '1d' });
    const provider = fakeProvider([], {
      list: vi.fn(async () => Promise.reject(new Error('nope'))),
    });

    await cleanup(ctx, getTracker());

    expect(provider.delete).not.toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining('Provider does not support listing: nope'),
    );
  });

  it('deletes files older than max-age', async () => {
    setOptions({ maxAge: '1d' });
    const provider = fakeProvider([file('old', 2), file('new', 0)]);

    await cleanup(ctx, getTracker());

    expect(deletedPaths(provider)).toEqual(['old']);
  });

  it('keeps only the newest max-files files', async () => {
    setOptions({ maxFiles: '1' });
    const provider = fakeProvider([
      file('middle', 2),
      file('newest', 1),
      file('oldest', 3),
    ]);

    await cleanup(ctx, getTracker());

    expect(deletedPaths(provider)).toEqual(['oldest', 'middle']);
  });

  it('deletes the oldest files until the total size fits max-size', async () => {
    setOptions({ maxSize: '20b' });
    const provider = fakeProvider([file('a', 3, 10), file('b', 2, 10), file('c', 1, 10)]);

    await cleanup(ctx, getTracker());

    expect(deletedPaths(provider)).toEqual(['a']);
  });

  it('deletes each file at most once when several limits match', async () => {
    setOptions({ maxAge: '1d', maxFiles: '1', maxSize: '1b' });
    const provider = fakeProvider([file('a', 3, 2), file('b', 2, 2), file('c', 0, 2)]);

    await cleanup(ctx, getTracker());

    expect(deletedPaths(provider)).toEqual(['a', 'b', 'c']);
  });

  it('does not over-delete for max-size when other limits already free space', async () => {
    setOptions({ maxAge: '1d', maxSize: '20b' });
    const provider = fakeProvider([
      file('a', 3, 10),
      file('b', 0.5, 10),
      file('c', 0.2, 10),
    ]);

    await cleanup(ctx, getTracker());

    // Deleting "a" for max-age already brings the total down to 20 bytes.
    expect(deletedPaths(provider)).toEqual(['a']);
  });

  it('keeps going when a delete fails', async () => {
    setOptions({ maxFiles: '1' });
    const provider = fakeProvider([file('a', 3), file('b', 2), file('c', 1)], {
      delete: vi.fn(async (path: string) =>
        path === 'a' ? Promise.reject(new Error('denied')) : undefined,
      ),
    });

    await cleanup(ctx, getTracker());

    expect(deletedPaths(provider)).toEqual(['a', 'b']);
    expect(ctx.log.info).toHaveBeenCalledWith('Deleted b');
  });

  it('reports when nothing needs to be deleted', async () => {
    setOptions({ maxAge: '1d' });
    fakeProvider([file('new', 0)]);

    await cleanup(ctx, getTracker());

    expect(ctx.log.info).toHaveBeenCalledWith('No files to clean up');
  });
});
