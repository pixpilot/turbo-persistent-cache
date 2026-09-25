import type { Tracker } from './tracker';
import process from 'node:process';

/**
 * Returns the first value that is neither `undefined` nor an empty string.
 */
export function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

export function timingProvider<Args extends unknown[], Result>(
  name: keyof Tracker,
  tracker: Tracker,
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const start = performance.now();
    const result = await fn(...args);
    const end = performance.now();
    if (process.env.LOG_LEVEL === 'debug') {
      // eslint-disable-next-line no-console
      console.log(`${name} took ${end - start}ms`);
    }
    // eslint-disable-next-line no-param-reassign -- the tracker accumulates timings across calls
    tracker[name] += end - start;
    return result;
  };
}
