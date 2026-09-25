import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TAG = 's43Vqe9K4fqUlFo3c/2drvp46vUGR8lLgb+28BwGUJM=';
const RUNNER_TEMP = '/tmp/runner-temp';

type Env = Record<string, string | undefined>;

async function loadConstants(env: Env = {}) {
  const defaults: Env = {
    CI: 'false',
    RUNNER_TEMP,
    CACHE_PREFIX: undefined,
    SERVER_PORT: undefined,
    USE_RELATIVE_CACHE_PATH: undefined,
  };
  for (const [name, value] of Object.entries({ ...defaults, ...env })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  return import('../../src/lib/constants');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getCacheKey', () => {
  it('appends artifact tag when signing is enabled', async () => {
    const { getCacheKey } = await loadConstants();
    expect(getCacheKey('abc123', TAG)).toBe(`turbogha_abc123#${TAG}`);
  });

  it('omits tag suffix when tag is empty', async () => {
    const { getCacheKey } = await loadConstants();
    expect(getCacheKey('abc123', '')).toBe('turbogha_abc123');
    expect(getCacheKey('abc123')).toBe('turbogha_abc123');
  });

  it('uses CACHE_PREFIX from the environment', async () => {
    const { getCacheKey } = await loadConstants({ CACHE_PREFIX: 'custom_' });
    expect(getCacheKey('abc123')).toBe('custom_abc123');
  });

  it('prefers action inputs over environment variables in CI', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('CACHE_PREFIX', 'env_');
    vi.stubEnv('SERVER_PORT', undefined);
    vi.resetModules();
    const actionsCore = await import('@actions/core');
    vi.mocked(actionsCore.getInput).mockImplementation((name: string) =>
      name === 'cache-prefix' ? 'input_' : '',
    );

    const { cachePrefix, serverPort } = await import('../../src/lib/constants');

    expect(cachePrefix).toBe('input_');
    expect(serverPort).toBe(41230);
  });
});

describe('server settings', () => {
  it('uses defaults when nothing is configured', async () => {
    const constants = await loadConstants();
    expect(constants.serverPort).toBe(41230);
    expect(constants.useRelativeCachePath).toBe(false);
    expect(constants.serverPortFile).toBe(join(RUNNER_TEMP, 'turbogha-port'));
    expect(constants.serverLogFile).toBe(join(RUNNER_TEMP, 'turbogha.log'));
  });

  it('reads SERVER_PORT and USE_RELATIVE_CACHE_PATH from the environment', async () => {
    const constants = await loadConstants({
      SERVER_PORT: '0',
      USE_RELATIVE_CACHE_PATH: 'true',
    });
    expect(constants.serverPort).toBe(0);
    expect(constants.useRelativeCachePath).toBe(true);
  });

  it('falls back to /tmp when RUNNER_TEMP is not set', async () => {
    const { getFsCachePath, serverPortFile } = await loadConstants({
      RUNNER_TEMP: undefined,
    });
    expect(getFsCachePath('abc')).toBe(join('/tmp', 'abc.tg.bin'));
    expect(serverPortFile).toBe(join('/tmp', 'turbogha-port'));
  });
});

describe('getTempCachePath', () => {
  it('base64url-encodes artifact tags so slashes do not create subdirectories', async () => {
    const { getCacheKey, getTempCachePath } = await loadConstants();
    const key = getCacheKey('7ee20327ec1a3d63', TAG);
    const encodedTag = Buffer.from(TAG, 'utf8').toString('base64url');
    expect(getTempCachePath(key)).toBe(
      join(RUNNER_TEMP, `cache-turbogha_7ee20327ec1a3d63--${encodedTag}.tg.bin`),
    );
  });

  it('assigns distinct temp paths per artifact tag', async () => {
    const { getCacheKey, getTempCachePath } = await loadConstants();
    const hash = '7ee20327ec1a3d63';
    const saveKeyA = getCacheKey(hash, 'tag/a');
    const saveKeyB = getCacheKey(hash, 'tag/b');
    const restoreKey = getCacheKey(hash);

    expect(getTempCachePath(saveKeyA)).not.toBe(getTempCachePath(saveKeyB));
    expect(getTempCachePath(restoreKey)).toBe(
      join(RUNNER_TEMP, 'cache-turbogha_7ee20327ec1a3d63.tg.bin'),
    );
  });
});
