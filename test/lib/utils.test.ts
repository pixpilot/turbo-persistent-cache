import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTracker } from '../../src/lib/tracker';
import { firstNonEmpty, timingProvider } from '../../src/lib/utils';

describe('firstNonEmpty', () => {
  it('returns the first defined, non-empty value', () => {
    expect(firstNonEmpty(undefined, '', 'a', 'b')).toBe('a');
  });

  it('returns undefined when every value is empty', () => {
    expect(firstNonEmpty(undefined, '')).toBeUndefined();
    expect(firstNonEmpty()).toBeUndefined();
  });
});

describe('timingProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the wrapped result and accumulates elapsed time', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40);
    const tracker = getTracker();
    const timed = timingProvider('save', tracker, async (a: number, b: number) => a + b);

    await expect(timed(1, 2)).resolves.toBe(3);
    await expect(timed(2, 3)).resolves.toBe(5);

    expect(tracker).toEqual({ save: 25, get: 0, delete: 0, list: 0 });
  });

  it('logs timings when LOG_LEVEL is debug', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const timed = timingProvider('get', getTracker(), async () => 'ok');

    await timed();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^get took .*ms$/u));
  });

  it('propagates errors without recording time', async () => {
    const tracker = getTracker();
    const timed = timingProvider('delete', tracker, async () => {
      throw new Error('boom');
    });

    await expect(timed()).rejects.toThrow('boom');
    expect(tracker.delete).toBe(0);
  });
});
