import type { Readable } from 'node:stream';
import type { RequestContext } from './server';
import type { TListFile } from './server/cleanup';
import type { Tracker } from './tracker';
import process from 'node:process';
import { core } from './core';
import { getGithubProvider } from './providers/cache';
import { getS3Provider } from './providers/s3';
import { firstNonEmpty } from './utils';

export interface TProvider {
  name: 'github' | 's3';
  save: (
    ctx: RequestContext,
    hash: string,
    tag: string,
    stream: Readable,
  ) => Promise<void>;
  get: (
    ctx: RequestContext,
    hash: string,
  ) => Promise<
    [number | undefined, Readable | ReadableStream, string | undefined] | null
  >;
  delete: (key: string) => Promise<void>;
  list: () => Promise<TListFile[]>;
}

export function getProvider(tracker: Tracker): TProvider {
  const provider = firstNonEmpty(core.getInput('provider'), process.env.PROVIDER);

  if (provider === undefined) {
    throw new Error(
      'Provider is required. Set PROVIDER environment variable or provider input.',
    );
  }

  if (provider === 'github') {
    return getGithubProvider(tracker);
  }
  if (provider === 's3') {
    return getS3Provider(tracker);
  }

  throw new Error(`Provider ${provider} not supported`);
}
