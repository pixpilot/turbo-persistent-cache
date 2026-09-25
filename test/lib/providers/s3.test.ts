import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTracker } from '../../../src/lib/tracker';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  clientConfig: vi.fn(),
  uploadOptions: vi.fn(),
  uploadDone: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = mocks.send;
      constructor(config: unknown) {
        mocks.clientConfig(config);
      }
    },
    ListObjectsV2Command: class ListObjectsV2Command extends FakeCommand {},
    GetObjectCommand: class GetObjectCommand extends FakeCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends FakeCommand {},
  };
});

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    done = mocks.uploadDone;
    constructor(options: unknown) {
      mocks.uploadOptions(options);
    }
  },
}));

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function sentCommand(index: number): SentCommand {
  return mocks.send.mock.calls[index][0] as SentCommand;
}

const S3_ENV_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'S3_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'S3_SESSION_TOKEN',
  'S3_BUCKET',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'S3_REGION',
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL',
  'S3_ENDPOINT',
  'S3_PREFIX',
];

async function loadS3(env: Record<string, string | undefined> = {}) {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  vi.stubEnv('CACHE_PREFIX', undefined);
  for (const name of S3_ENV_NAMES) vi.stubEnv(name, undefined);
  const defaults = {
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET: 'bucket',
    AWS_REGION: 'us-east-1',
  };
  for (const [name, value] of Object.entries({ ...defaults, ...env })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const { getS3Provider } = await import('../../../src/lib/providers/s3');
  return getS3Provider(getTracker());
}

const ctx = { log: { info: vi.fn() } };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

describe('getS3Provider configuration', () => {
  it('requires credentials, bucket and region', async () => {
    await expect(loadS3({ S3_BUCKET: undefined })).rejects.toThrow(
      'S3 provider requires s3-access-key-id, s3-secret-access-key, s3-bucket, and s3-region',
    );
  });

  it('uses the default endpoint', async () => {
    await loadS3();
    expect(mocks.clientConfig).toHaveBeenCalledWith({
      region: 'us-east-1',
      endpoint: 'https://s3.amazonaws.com',
      credentials: {
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        sessionToken: undefined,
      },
    });
  });

  it('falls back to the S3_* environment variables', async () => {
    await loadS3({
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_REGION: undefined,
      S3_ACCESS_KEY_ID: 's3-key',
      S3_SECRET_ACCESS_KEY: 's3-secret',
      S3_SESSION_TOKEN: 's3-token',
      S3_REGION: 'eu-west-1',
      S3_ENDPOINT: 'https://minio.local',
    });
    expect(mocks.clientConfig).toHaveBeenCalledWith({
      region: 'eu-west-1',
      endpoint: 'https://minio.local',
      credentials: {
        accessKeyId: 's3-key',
        secretAccessKey: 's3-secret',
        sessionToken: 's3-token',
      },
    });
  });
});

describe('save', () => {
  it('uploads the artifact under the prefixed key', async () => {
    const provider = await loadS3({ S3_PREFIX: 'cache/' });
    mocks.uploadDone.mockResolvedValue({});
    const body = Readable.from(['data']);

    await provider.save(ctx, 'abc', 'tag', body);

    expect(mocks.uploadOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          Bucket: 'bucket',
          Key: 'cache/turbogha_abc#tag',
          Body: body,
          ContentType: 'application/octet-stream',
        },
      }),
    );
  });

  it('rethrows upload errors', async () => {
    const provider = await loadS3();
    mocks.uploadDone.mockRejectedValue(new Error('denied'));

    await expect(provider.save(ctx, 'abc', '', Readable.from(['data']))).rejects.toThrow(
      'denied',
    );
  });
});

describe('get', () => {
  it('returns null when nothing is stored for the hash', async () => {
    const provider = await loadS3();
    mocks.send.mockResolvedValue({ Contents: [] });

    await expect(provider.get(ctx, 'abc')).resolves.toBeNull();
    expect(sentCommand(0).constructor.name).toBe('ListObjectsV2Command');
    expect(sentCommand(0).input).toEqual({
      Bucket: 'bucket',
      Prefix: 'turbogha/turbogha_abc',
      MaxKeys: 10,
    });
  });

  it('returns the newest matching object with its tag', async () => {
    const provider = await loadS3();
    const body = Readable.from(['hello']);
    mocks.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'turbogha/turbogha_abc#old', LastModified: new Date(1000) },
          { Key: 'turbogha/turbogha_abc#new', LastModified: new Date(2000) },
          { Key: undefined },
        ],
      })
      .mockResolvedValueOnce({ Body: body, ContentLength: 5 });

    await expect(provider.get(ctx, 'abc')).resolves.toEqual([5, body, 'new']);
    expect(sentCommand(1).constructor.name).toBe('GetObjectCommand');
    expect(sentCommand(1).input).toEqual({
      Bucket: 'bucket',
      Key: 'turbogha/turbogha_abc#new',
    });
  });

  it('returns no tag for untagged objects', async () => {
    const provider = await loadS3();
    const body = Readable.from(['hello']);
    mocks.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'turbogha/turbogha_abc' }] })
      .mockResolvedValueOnce({ Body: body, ContentLength: 5 });

    await expect(provider.get(ctx, 'abc')).resolves.toEqual([5, body, undefined]);
  });

  it('ignores objects of other hashes that share the same prefix', async () => {
    const provider = await loadS3();
    mocks.send.mockResolvedValueOnce({
      Contents: [{ Key: 'other' }, { Key: 'turbogha/turbogha_abcdef#tag' }],
    });

    await expect(provider.get(ctx, 'abc')).resolves.toBeNull();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('returns null when the object has no body', async () => {
    const provider = await loadS3();
    mocks.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'turbogha/turbogha_abc' }] })
      .mockResolvedValueOnce({});

    await expect(provider.get(ctx, 'abc')).resolves.toBeNull();
  });

  it('treats S3 errors as a cache miss', async () => {
    const provider = await loadS3();
    mocks.send.mockRejectedValue(new Error('timeout'));

    await expect(provider.get(ctx, 'abc')).resolves.toBeNull();
  });
});

describe('delete', () => {
  it('deletes the object by key', async () => {
    const provider = await loadS3();
    mocks.send.mockResolvedValue({});

    await provider.delete('turbogha/turbogha_abc');

    expect(sentCommand(0).constructor.name).toBe('DeleteObjectCommand');
    expect(sentCommand(0).input).toEqual({
      Bucket: 'bucket',
      Key: 'turbogha/turbogha_abc',
    });
  });

  it('rethrows delete errors', async () => {
    const provider = await loadS3();
    mocks.send.mockRejectedValue(new Error('denied'));

    await expect(provider.delete('key')).rejects.toThrow('denied');
  });
});

describe('list', () => {
  it('follows continuation tokens across pages', async () => {
    const provider = await loadS3();
    const lastModified = new Date('2026-01-01T00:00:00.000Z');
    mocks.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'turbogha/a', LastModified: lastModified, Size: 1 },
          { Key: undefined },
        ],
        NextContinuationToken: 'next',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'turbogha/b', LastModified: lastModified }],
      });

    await expect(provider.list()).resolves.toEqual([
      { path: 'turbogha/a', createdAt: lastModified.toISOString(), size: 1 },
      { path: 'turbogha/b', createdAt: lastModified.toISOString(), size: 0 },
    ]);
    expect(sentCommand(0).input).toMatchObject({
      Prefix: 'turbogha/',
      ContinuationToken: undefined,
    });
    expect(sentCommand(1).input).toMatchObject({ ContinuationToken: 'next' });
  });

  it('rethrows list errors', async () => {
    const provider = await loadS3();
    mocks.send.mockRejectedValue(new Error('denied'));

    await expect(provider.list()).rejects.toThrow('denied');
  });
});
