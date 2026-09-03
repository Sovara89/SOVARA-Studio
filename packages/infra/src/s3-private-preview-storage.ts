import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { normalizeS3Error } from './s3-multipart-storage.js';

export type PrivatePreviewStorage = {
  presignPut(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
  headObject(
    objectKey: string,
  ): Promise<{ contentType: string | null; contentLength: number; etag: string | null } | 'absent'>;
  finalizeStagedObject(input: {
    stagingObjectKey: string;
    readyObjectKey: string;
    etag: string;
  }): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
};
export function createS3PrivatePreviewStorage(
  client: S3Client,
  bucket: string,
  presignClient: S3Client = client,
): PrivatePreviewStorage {
  return {
    async presignPut(input) {
      try {
        return await getSignedUrl(
          presignClient,
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.objectKey,
            ContentType: input.contentType,
          }),
          { expiresIn: input.expiresInSeconds },
        );
      } catch (error) {
        throw normalizeS3Error('presign PutObject', error);
      }
    },
    async headObject(objectKey) {
      try {
        const value = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return {
          contentType: value.ContentType ?? null,
          contentLength: value.ContentLength ?? 0,
          etag: value.ETag ?? null,
        };
      } catch (error) {
        if (
          (error as { name?: string }).name === 'NotFound' ||
          (error as { name?: string }).name === 'NoSuchKey'
        )
          return 'absent';
        throw normalizeS3Error('HeadObject', error);
      }
    },
    async finalizeStagedObject(input) {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: input.readyObjectKey,
            CopySource: `${bucket}/${encodeURIComponent(input.stagingObjectKey).replace(/%2F/g, '/')}`,
            CopySourceIfMatch: input.etag,
          }),
        );
      } catch (error) {
        throw normalizeS3Error('CopyObject', error);
      }
    },
    async deleteObject(objectKey) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      } catch (error) {
        throw normalizeS3Error('DeleteObject', error);
      }
    },
  };
}
