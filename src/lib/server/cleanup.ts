import type { RequestContext } from '.';
import type { Tracker } from '../tracker';
import process from 'node:process';
import parse from 'parse-duration';
import { core } from '../core';
import { getProvider } from '../providers';
import { firstNonEmpty } from '../utils';
import { parseFileSize } from './utils';

export interface TListFile {
  path: string;
  createdAt: string;
  size: number;
}

type TCleanupReason = 'max-age' | 'max-files' | 'max-size';

/**
 * Treats `null`, `NaN` and `0` as "not a usable limit", matching the original
 * falsy checks on the parsed values.
 */
function toLimit(value: number | null): number | undefined {
  return value === null || Number.isNaN(value) || value === 0 ? undefined : value;
}

function byCreatedAt(a: TListFile, b: TListFile): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function invalidOption(name: string): never {
  const message = `Invalid ${name} provided`;
  core.error(message);
  throw new Error(message);
}

export async function cleanup(ctx: RequestContext, tracker: Tracker): Promise<void> {
  const maxAge = firstNonEmpty(core.getInput('max-age'), process.env.MAX_AGE);
  const maxFiles = firstNonEmpty(core.getInput('max-files'), process.env.MAX_FILES);
  const maxSize = firstNonEmpty(core.getInput('max-size'), process.env.MAX_SIZE);

  if (maxAge === undefined && maxFiles === undefined && maxSize === undefined) {
    ctx.log.info('No cleanup options provided, skipping cleanup');
    return;
  }

  const maxAgeParsed = maxAge === undefined ? undefined : toLimit(parse(maxAge));
  const maxFilesParsed =
    maxFiles === undefined ? undefined : toLimit(Number.parseInt(maxFiles, 10));
  const maxSizeParsed =
    maxSize === undefined ? undefined : toLimit(parseFileSize(maxSize));

  if (maxAge !== undefined && maxAgeParsed === undefined) {
    invalidOption('max-age');
  }

  if (maxFiles !== undefined && maxFilesParsed === undefined) {
    invalidOption('max-files');
  }

  if (maxSize !== undefined && maxSizeParsed === undefined) {
    invalidOption('max-size');
  }

  const provider = getProvider(tracker);

  if (provider.name === 'github') {
    core.error('Cleanup options are not available when using the GitHub provider');
    throw new Error('Cleanup options are not available when using the GitHub provider');
  }

  let files: TListFile[];
  try {
    files = await provider.list();
  } catch (e) {
    const msg = `Provider does not support listing: ${(e as Error).message}
Exiting early, no files were cleaned up.`;
    ctx.log.info(msg);
    return;
  }

  const fileToDelete: (TListFile & { reason: TCleanupReason })[] = [];
  if (maxAgeParsed !== undefined) {
    const now = new Date();
    const age = new Date(now.getTime() - maxAgeParsed);
    fileToDelete.push(
      ...files
        .filter((file) => new Date(file.createdAt) < age)
        .map((file) => ({ ...file, reason: 'max-age' as const })),
    );
  }

  if (maxFilesParsed !== undefined && files.length > maxFilesParsed) {
    const sortedByDate = [...files].sort(byCreatedAt);
    const excessFiles = sortedByDate.slice(0, files.length - maxFilesParsed);
    excessFiles.forEach((file) => {
      if (!fileToDelete.some((f) => f.path === file.path)) {
        fileToDelete.push({ ...file, reason: 'max-files' });
      }
    });
  }

  if (maxSizeParsed !== undefined) {
    //* Only count files the other limits keep, so max-size does not over-delete
    const remaining = files
      .filter((file) => !fileToDelete.some((f) => f.path === file.path))
      .sort(byCreatedAt);
    let totalSize = remaining.reduce((sum, file) => sum + file.size, 0);

    for (const file of remaining) {
      if (totalSize <= maxSizeParsed) break;

      fileToDelete.push({ ...file, reason: 'max-size' });
      totalSize -= file.size;
    }
  }

  if (fileToDelete.length > 0) {
    ctx.log.info(
      `Cleaning up ${fileToDelete.length} files (${fileToDelete
        .map((f) => `${f.path} (${f.reason})`)
        .join(',')})`,
    );
    for (const file of fileToDelete) {
      try {
        // eslint-disable-next-line no-await-in-loop -- delete one at a time to stay within provider rate limits
        await provider.delete(file.path);
        ctx.log.info(`Deleted ${file.path}`);
      } catch (error) {
        core.error(`Failed to delete ${file.path}: ${String(error)}`);
      }
    }
  } else {
    ctx.log.info('No files to clean up');
  }
}
