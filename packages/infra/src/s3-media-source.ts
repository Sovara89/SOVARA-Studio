import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { MediaSource } from '@sovara-studio/platforms';

export type S3MediaSourceInput = {
  client: S3Client;
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  versionId?: string | null;
  expectedEtag?: string | null;
};

function validateRange(sizeBytes: number, start: number, endExclusive: number) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start ||
    endExclusive > sizeBytes
  )
    throw new Error('Media range is outside the verified object');
}

export function createS3MediaSource(input: S3MediaSourceInput): MediaSource {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0)
    throw new Error('Verified media size must be a positive safe integer');
  if (!input.bucket.trim() || !input.objectKey.trim() || !input.contentType.trim())
    throw new Error('Media storage identity is incomplete');

  return {
    sizeBytes: input.sizeBytes,
    contentType: input.contentType,
    openReadStream: async ({
      start = 0,
      endExclusive = input.sizeBytes,
      signal,
    }: {
      start?: number;
      endExclusive?: number;
      signal?: AbortSignal;
    } = {}) => {
      validateRange(input.sizeBytes, start, endExclusive);
      const response = await input.client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.objectKey,
          VersionId: input.versionId ?? undefined,
          IfMatch: input.expectedEtag ?? undefined,
          ...(start !== 0 || endExclusive !== input.sizeBytes
            ? { Range: `bytes=${start}-${endExclusive - 1}` }
            : {}),
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      const body = response.Body;
      if (body instanceof Readable) return body;
      if (body && Symbol.asyncIterator in body)
        return Readable.from(body as AsyncIterable<Uint8Array>);
      throw new Error('S3 GetObject returned no readable body');
    },
  };
}
