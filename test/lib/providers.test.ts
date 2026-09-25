import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTracker } from '../../src/lib/tracker';

async function loadGetProvider(provider: string | undefined) {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  vi.stubEnv('PROVIDER', provider);
  vi.stubEnv('S3_BUCKET', undefined);
  vi.resetModules();
  const { getProvider } = await import('../../src/lib/providers');
  return getProvider;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getProvider', () => {
  it('requires a provider', async () => {
    const getProvider = await loadGetProvider(undefined);
    expect(() => getProvider(getTracker())).toThrow('Provider is required');
  });

  it('returns the GitHub provider', async () => {
    const getProvider = await loadGetProvider('github');
    expect(getProvider(getTracker()).name).toBe('github');
  });

  it('returns the S3 provider (which validates its settings)', async () => {
    const getProvider = await loadGetProvider('s3');
    expect(() => getProvider(getTracker())).toThrow('S3 provider requires');
  });

  it('rejects unknown providers', async () => {
    const getProvider = await loadGetProvider('azure');
    expect(() => getProvider(getTracker())).toThrow('Provider azure not supported');
  });
});
