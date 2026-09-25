import type { Readable } from 'node:stream';
import type { TProvider } from '../../providers';
import type { RequestContext } from '../../server';
import type { TListFile } from '../../server/cleanup';
import type { Tracker } from '../../tracker';
import process from 'node:process';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getCacheKey } from '../../constants';
import { core } from '../../core';
import { firstNonEmpty, timingProvider } from '../../utils';

const DEFAULT_S3_ENDPOINT = 'https://s3.amazonaws.com';
const DEFAULT_S3_PREFIX = 'turbogha/';
const LOOKUP_MAX_KEYS = 10;
const LIST_MAX_KEYS = 1000;

// Helper function to get input value, prioritizing environment variables for local development
function getInput(name: string, envNames?: string[]): string | undefined {
  // In GitHub Actions context, try core.getInput first
  if (process.env.GITHUB_ACTIONS === 'true') {
    const coreInput = firstNonEmpty(core.getInput(name));
    if (coreInput !== undefined) return coreInput;
  }

  // Fall back to environment variable
  const envVars = envNames ?? [name.toUpperCase().replace(/-/gu, '_')];
  return firstNonEmpty(...envVars.map((envVar) => process.env[envVar]));
}

export function getS3Provider(tracker: Tracker): TProvider {
  const s3AccessKeyId = getInput('s3-access-key-id', [
    'AWS_ACCESS_KEY_ID',
    'S3_ACCESS_KEY_ID',
  ]);
  const s3SecretAccessKey = getInput('s3-secret-access-key', [
    'AWS_SECRET_ACCESS_KEY',
    'S3_SECRET_ACCESS_KEY',
  ]);
  const s3SessionToken = getInput('s3-session-token', [
    'AWS_SESSION_TOKEN',
    'S3_SESSION_TOKEN',
  ]);
  const s3Bucket = getInput('s3-bucket', ['S3_BUCKET']);
  const s3Region = getInput('s3-region', [
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'S3_REGION',
  ]);
  const s3Endpoint =
    getInput('s3-endpoint', ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'S3_ENDPOINT']) ??
    DEFAULT_S3_ENDPOINT;
  const s3Prefix = getInput('s3-prefix', ['S3_PREFIX']) ?? DEFAULT_S3_PREFIX;

  if (
    s3AccessKeyId === undefined ||
    s3SecretAccessKey === undefined ||
    s3Bucket === undefined ||
    s3Region === undefined
  ) {
    throw new Error(
      'S3 provider requires s3-access-key-id, s3-secret-access-key, s3-bucket, and s3-region. Set these as environment variables or GitHub Actions inputs.',
    );
  }

  const s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
      sessionToken: s3SessionToken,
    },
  });

  const getS3Key = (hash: string, tag?: string): string =>
    `${s3Prefix}${getCacheKey(hash, tag)}`;

  const save = async (
    ctx: RequestContext,
    hash: string,
    tag: string,
    stream: Readable,
  ): Promise<void> => {
    const objectKey = getS3Key(hash, tag);
    try {
      // Use the S3 Upload utility which handles multipart uploads for large files
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: s3Bucket,
          Key: objectKey,
          Body: stream,
          ContentType: 'application/octet-stream',
        },
      });

      await upload.done();
      ctx.log.info(`Saved artifact to S3: ${objectKey}`);
    } catch (error) {
      ctx.log.info(`Error saving artifact to S3: ${String(error)}`);
      throw error;
    }
  };

  const get = async (
    ctx: RequestContext,
    hash: string,
  ): Promise<
    [number | undefined, Readable | ReadableStream, string | undefined] | null
  > => {
    // First try to get with just the hash
    const objectKey = getS3Key(hash);

    try {
      // Try to find the object
      const listCommand = new ListObjectsV2Command({
        Bucket: s3Bucket,
        Prefix: objectKey,
        MaxKeys: LOOKUP_MAX_KEYS,
      });

      const listResponse = await s3Client.send(listCommand);

      if (listResponse.Contents === undefined || listResponse.Contents.length === 0) {
        ctx.log.info(`No cached artifact found for ${hash}`);
        return null;
      }

      // Find the most recent object for this exact hash (optionally followed by `#tag`)
      const matchingKeys = listResponse.Contents.filter(
        (obj) => obj.Key === objectKey || obj.Key?.startsWith(`${objectKey}#`) === true,
      ).sort(
        // Sort by last modified date, newest first
        (a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
      );

      const key = matchingKeys[0]?.Key;
      if (key === undefined) {
        return null;
      }

      // Get the object
      const getCommand = new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      });

      const response = await s3Client.send(getCommand);

      if (response.Body === undefined) {
        ctx.log.info(`Failed to get artifact body from S3`);
        return null;
      }

      const size = response.ContentLength;
      const stream = response.Body as Readable;

      // Extract the tag if it exists
      const artifactTag = key.includes('#') ? key.split('#').at(-1) : undefined;

      ctx.log.info(`Retrieved artifact from S3: ${key}`);
      return [size, stream, artifactTag];
    } catch (error) {
      ctx.log.info(`Error getting artifact from S3: ${String(error)}`);
      return null;
    }
  };

  const deleteObj = async (key: string): Promise<void> => {
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      });

      await s3Client.send(deleteCommand);
    } catch (error) {
      core.error(`Error deleting artifact from S3: ${String(error)}`);
      throw error;
    }
  };

  const list = async (): Promise<TListFile[]> => {
    try {
      const files: TListFile[] = [];
      let continuationToken: string | undefined;

      do {
        // Create a new command for each request with the current continuation token
        const listCommand = new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: s3Prefix,
          MaxKeys: LIST_MAX_KEYS,
          ContinuationToken: continuationToken,
        });

        core.debug(
          `Listing S3 objects with prefix ${s3Prefix}${continuationToken === undefined ? '' : ' and continuation token'}`,
        );

        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's continuation token
        const response = await s3Client.send(listCommand);

        if (response.Contents !== undefined && response.Contents.length > 0) {
          core.debug(`Found ${response.Contents.length} objects`);

          for (const obj of response.Contents) {
            if (obj.Key === undefined || obj.Key === '') continue;
            files.push({
              path: obj.Key,
              createdAt: (obj.LastModified ?? new Date()).toISOString(),
              size: obj.Size ?? 0,
            });
          }
        }

        continuationToken = response.NextContinuationToken;
        if (continuationToken !== undefined) {
          core.debug(`NextContinuationToken: ${continuationToken}`);
        }
      } while (continuationToken !== undefined);

      core.debug(`Total files listed: ${files.length}`);
      return files;
    } catch (error) {
      core.error(`Error listing artifacts from S3: ${String(error)}`);
      throw error;
    }
  };

  return {
    name: 's3',
    save: timingProvider('save', tracker, save),
    get: timingProvider('get', tracker, get),
    delete: timingProvider('delete', tracker, deleteObj),
    list: timingProvider('list', tracker, list),
  };
}
