import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import process from 'node:process';
import { core } from './core';
import { env } from './env';
import { firstNonEmpty } from './utils';

const DEFAULT_SERVER_PORT = '41230';
const FALLBACK_TEMP_DIR = '/tmp';

// Helper function to get input value, prioritizing environment variables for local development
function getInput(name: string, envName?: string): string | undefined {
  // In GitHub Actions context, try core.getInput first
  if (process.env.CI === 'true') {
    const coreInput = firstNonEmpty(core.getInput(name));
    if (coreInput !== undefined) return coreInput;
  }

  // Fall back to environment variable
  const envVar = firstNonEmpty(envName) ?? name.toUpperCase().replace(/-/gu, '_');
  return process.env[envVar];
}

const tempDir = firstNonEmpty(env.RUNNER_TEMP) ?? FALLBACK_TEMP_DIR;

export const serverPort = Number.parseInt(
  firstNonEmpty(getInput('server-port', 'SERVER_PORT')) ?? DEFAULT_SERVER_PORT,
  10,
);
export const cachePath = 'turbogha_';
export const cachePrefix =
  firstNonEmpty(getInput('cache-prefix', 'CACHE_PREFIX')) ?? cachePath;
export const useRelativeCachePath =
  getInput('use-relative-cache-path', 'USE_RELATIVE_CACHE_PATH') === 'true';
export function getCacheKey(hash: string, tag?: string): string {
  const suffix = tag !== undefined && tag !== '' ? `#${tag}` : '';
  return `${cachePrefix}${hash}${suffix}`;
}
export const serverPortFile = join(tempDir, 'turbogha-port');
export const serverLogFile = join(tempDir, 'turbogha.log');
export function getFsCachePath(hash: string): string {
  return join(tempDir, `${hash}.tg.bin`);
}

function encodeArtifactTagForPath(tag: string): string {
  return Buffer.from(tag, 'utf8').toString('base64url');
}

export function getTempCachePath(key: string): string {
  const [pathKey, tag] = key.split('#');
  const fileName =
    tag !== undefined && tag !== ''
      ? `cache-${pathKey}--${encodeArtifactTagForPath(tag)}.tg.bin`
      : `cache-${pathKey}.tg.bin`;
  return join(tempDir, fileName);
}
