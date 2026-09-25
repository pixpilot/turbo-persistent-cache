import type { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { restoreCache, saveCache } from '@actions/cache';
import streamToPromise from 'stream-to-promise';
import { getTempCachePath, useRelativeCachePath } from '../../constants';
import { core } from '../../core';
import { env } from '../../env';

const RATE_LIMIT_RETRY_DELAY_MS = 1000;

let relativeCachePathLock = Promise.resolve();

async function withCachePath<T>(
  path: string,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  if (!useRelativeCachePath) {
    return operation(path);
  }

  const previousOperation = relativeCachePathLock;
  let releaseLock: (() => void) | undefined;
  relativeCachePathLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousOperation.catch(() => undefined);

  const previousCwd = process.cwd();
  let changedCwd = false;
  try {
    process.chdir(dirname(path));
    changedCwd = true;
    return await operation(basename(path));
  } finally {
    if (changedCwd) process.chdir(previousCwd);
    releaseLock?.();
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('429') || msg.includes('rate limit');
}

class HandledError extends Error {
  status: number;
  statusText: string;
  data: unknown;
  constructor(status: number, statusText: string, data: unknown) {
    super(`${status}: ${statusText}`);
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

function handleFetchError(message: string): (error: unknown) => never {
  return (error: unknown) => {
    if (error instanceof HandledError) {
      core.error(`${message}: ${error.status} ${error.statusText}`);
      core.error(JSON.stringify(error.data));
      throw error;
    }
    core.error(`${message}: ${String(error)}`);
    throw error;
  };
}

export interface CacheClient {
  save: (key: string, stream: Readable) => Promise<void>;
  restore: (path: string, key: string) => Promise<string | undefined>;
}

export function getCacheClient(): CacheClient {
  if (!env.valid) {
    throw new Error('Cache API env vars are not set');
  }

  const save = async (key: string, stream: Readable): Promise<void> => {
    //* Create a temporary file to store the cache
    const tempFile = getTempCachePath(key);
    try {
      const writeStream = createWriteStream(tempFile);
      await streamToPromise(stream.pipe(writeStream));
      core.info(`Saved cache to ${tempFile}`);

      core.info(`Saving cache for key: ${key}, path: ${tempFile}`);
      await withCachePath(tempFile, async (cachePath) => saveCache([cachePath], key));
      core.info(`Saved cache ${key}`);
    } catch (error) {
      handleFetchError('Unable to upload cache')(error);
    } finally {
      //* Remove the temporary file, also when the upload failed
      await rm(tempFile, { force: true });
    }
  };

  const restore = async (path: string, key: string): Promise<string | undefined> => {
    core.info(`Querying cache for key: ${key}, path: ${path}`);

    try {
      return await withCachePath(path, async (cachePath) =>
        restoreCache([cachePath], key, [key]),
      );
    } catch (error) {
      if (isRateLimitError(error)) {
        core.warning(`Rate limited restoring cache for key ${key}, retrying in 1s`);
        await sleep(RATE_LIMIT_RETRY_DELAY_MS);
        try {
          return await withCachePath(path, async (cachePath) =>
            restoreCache([cachePath], key, [key]),
          );
        } catch (retryError) {
          core.warning(
            `Failed to restore cache for key ${key} after retry: ${String(retryError)}`,
          );
          return undefined;
        }
      }
      throw error;
    }
  };

  return {
    save,
    restore,
  };
}
