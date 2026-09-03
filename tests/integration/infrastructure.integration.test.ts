import { Client } from 'pg';
import Redis from 'ioredis';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, test } from 'vitest';

describe('local infrastructure', () => {
  test('connects to PostgreSQL, Redis, and private MinIO bucket', async () => {
    const pg = new Client({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://sovara:sovara@localhost:15432/sovara',
    });
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 16379),
    });
    const s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    const bucket = process.env.S3_BUCKET ?? 'sovara-uploads';
    const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:19000';
    const key = `integration/private-${Date.now()}.txt`;
    let testError: unknown;
    let cleanupError: unknown;
    try {
      await pg.connect();
      expect((await pg.query('select 1')).rowCount).toBe(1);
      expect(await redis.ping()).toBe('PONG');
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));

      const signedPutUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain' }),
        { expiresIn: 300 },
      );
      const browserPut = await fetch(signedPutUrl, {
        method: 'PUT',
        headers: { Origin: 'http://localhost:5173', 'Content-Type': 'text/plain' },
        body: 'private',
      });
      expect(browserPut.ok).toBe(true);
      expect(browserPut.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(browserPut.headers.get('access-control-expose-headers')).toMatch(/etag/i);
      const etag = browserPut.headers.get('etag');
      expect(etag).toBeTruthy();
      expect(etag?.length).toBeGreaterThan(0);
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      const anonymousResponse = await fetch(`${endpoint}/${bucket}/${key}`);
      expect([401, 403]).toContain(anonymousResponse.status);

      const preflight = await fetch(`${endpoint}/${bucket}/${key}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect([200, 204]).toContain(preflight.status);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);

      const corsProbe = await fetch(`${endpoint}/${bucket}/${key}`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(corsProbe.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(corsProbe.headers.get('access-control-expose-headers')).toMatch(/etag/i);
    } catch (error) {
      testError = error;
    }
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      cleanupError = error;
    } finally {
      await pg.end().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      s3.destroy();
    }
    if (testError) throw testError;
    if (cleanupError) throw cleanupError;
  });
});
