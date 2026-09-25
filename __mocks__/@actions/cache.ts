/**
 * This file is used to mock the `@actions/cache` module in tests.
 */
import { vi } from 'vitest';

export const restoreCache =
  vi.fn<
    (
      paths: string[],
      primaryKey: string,
      restoreKeys?: string[],
    ) => Promise<string | undefined>
  >();

export const saveCache = vi.fn<(paths: string[], key: string) => Promise<number>>();
