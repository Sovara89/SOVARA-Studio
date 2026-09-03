import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';
import { createS3Client } from './factories.js';
import {
  S3StorageError,
  createS3MultipartStorage,
  normalizeS3Error,
} from './s3-multipart-storage.js';

const configuration = { bucket: 'private-bucket' };

describe('S3 multipart storage', () => {
  test('uses one SDK attempt for multipart initiation', async () => {
    const client = createS3Client({
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
      maxAttempts: 1,
    });
    expect(await client.config.maxAttempts()).toBe(1);
    client.destroy();
  });

  test('returns the provider upload ID and sends the exact server key', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    let commandName = '';
    let commandInput: Record<string, unknown> | undefined;
    client.send = (async (command) => {
      commandName = command.constructor.name;
      commandInput = command.input as Record<string, unknown>;
      return { UploadId: 'provider-upload-id' };
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(
      storage.createMultipartUpload({ objectKey: 'sources/ab/uuid', contentType: 'video/mp4' }),
    ).resolves.toEqual({ providerUploadId: 'provider-upload-id' });
    expect(commandName).toBe('CreateMultipartUploadCommand');
    expect(commandInput).toMatchObject({ Bucket: 'private-bucket', Key: 'sources/ab/uuid' });
    client.destroy();
  });

  test('classifies an initiation transport failure as ambiguous without retrying', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    let calls = 0;
    client.send = (async () => {
      calls += 1;
      const error = Object.assign(new Error('timeout'), {
        name: 'TimeoutError',
        $metadata: { httpStatusCode: undefined },
      });
      throw error;
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(
      storage.createMultipartUpload({ objectKey: 'sources/ab/uuid', contentType: 'video/mp4' }),
    ).rejects.toMatchObject({ ambiguous: true, retryable: true });
    expect(calls).toBe(1);
    client.destroy();
  });

  test('recognizes an already-absent provider upload during abort', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    client.send = (async () => {
      throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(
      storage.abortMultipartUpload({
        objectKey: 'sources/ab/uuid',
        providerUploadId: 'provider-id',
      }),
    ).resolves.toBe('already_absent');
    client.destroy();
  });

  test('paginates exact provider parts without changing opaque ETags', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    const inputs: Record<string, unknown>[] = [];
    let call = 0;
    client.send = (async (command) => {
      inputs.push(command.input as Record<string, unknown>);
      call += 1;
      return call === 1
        ? {
            Parts: [{ PartNumber: 1, ETag: 'opaque-1', Size: 5 }],
            IsTruncated: true,
            NextPartNumberMarker: '1',
          }
        : { Parts: [{ PartNumber: 2, ETag: 'opaque-2', Size: 7 }], IsTruncated: false };
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(
      storage.inspectMultipartUpload({
        objectKey: 'sources/ab/uuid',
        providerUploadId: 'provider-id',
      }),
    ).resolves.toEqual({
      parts: [
        { partNumber: 1, etag: 'opaque-1', sizeBytes: 5 },
        { partNumber: 2, etag: 'opaque-2', sizeBytes: 7 },
      ],
    });
    expect(inputs[1]).toMatchObject({ PartNumberMarker: '1' });
    client.destroy();
  });

  test('completes with backend-owned identity and exact ordered ETags', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    let commandName = '';
    let commandInput: Record<string, unknown> | undefined;
    client.send = (async (command) => {
      commandName = command.constructor.name;
      commandInput = command.input as Record<string, unknown>;
      return { ETag: 'opaque-composite', VersionId: 'version-1' };
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(
      storage.completeMultipartUpload({
        objectKey: 'sources/ab/uuid',
        providerUploadId: 'provider-id',
        parts: [
          { partNumber: 1, etag: 'opaque-1', sizeBytes: 5 },
          { partNumber: 2, etag: 'opaque-2', sizeBytes: 7 },
        ],
      }),
    ).resolves.toMatchObject({ etag: 'opaque-composite', versionId: 'version-1' });
    expect(commandName).toBe('CompleteMultipartUploadCommand');
    expect(commandInput).toMatchObject({
      Bucket: 'private-bucket',
      Key: 'sources/ab/uuid',
      UploadId: 'provider-id',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: 'opaque-1' },
          { PartNumber: 2, ETag: 'opaque-2' },
        ],
      },
    });
    client.destroy();
  });

  test('requests full-object checksum metadata during HEAD verification', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    let commandInput: Record<string, unknown> | undefined;
    client.send = (async (command) => {
      commandInput = command.input as Record<string, unknown>;
      return {
        ContentLength: 12,
        ContentType: 'video/mp4',
        ETag: 'opaque-etag',
        ChecksumType: 'FULL_OBJECT',
        ChecksumSHA256: 'full-object-checksum',
      };
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(storage.headObject('sources/ab/uuid')).resolves.toMatchObject({
      checksumAlgorithm: 'sha256',
      checksumValue: 'full-object-checksum',
    });
    expect(commandInput).toMatchObject({
      Bucket: 'private-bucket',
      Key: 'sources/ab/uuid',
      ChecksumMode: 'ENABLED',
    });
    client.destroy();
  });

  test('reconciles only the exact object key and confirms cleanup with a second listing', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let listCall = 0;
    client.send = (async (command) => {
      calls.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        listCall += 1;
        return listCall === 1
          ? { Uploads: [{ Key: 'sources/ab/uuid', UploadId: 'provider-id' }, { Key: 'other' }] }
          : { Uploads: [] };
      }
      return {};
    }) as S3Client['send'];
    const storage = createS3MultipartStorage(client, configuration);
    await expect(storage.reconcileUntrackedExactKey('sources/ab/uuid')).resolves.toBe('cleaned');
    expect(calls).toEqual([
      {
        name: 'ListMultipartUploadsCommand',
        input: { Bucket: 'private-bucket', Prefix: 'sources/ab/uuid' },
      },
      {
        name: 'AbortMultipartUploadCommand',
        input: { Bucket: 'private-bucket', Key: 'sources/ab/uuid', UploadId: 'provider-id' },
      },
      {
        name: 'ListMultipartUploadsCommand',
        input: { Bucket: 'private-bucket', Prefix: 'sources/ab/uuid' },
      },
    ]);
    client.destroy();
  });

  test('normalizes provider errors without retaining their message for clients', () => {
    const normalized = normalizeS3Error(
      'UploadPart',
      Object.assign(new Error('secret provider response'), {
        name: 'SlowDown',
        $metadata: { httpStatusCode: 503 },
      }),
    );
    expect(normalized).toBeInstanceOf(S3StorageError);
    expect(normalized.message).toBe('S3 UploadPart failed');
    expect(normalized.ambiguous).toBe(true);
  });
});
