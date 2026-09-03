import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase } from '../../packages/db/src/index.js';
import { createAuth } from '../../apps/api/src/auth/options.js';

const apiUrl = process.env.TEST_COMPOSE_API_URL ?? 'http://localhost:13000';
const publicStorageUrl = process.env.S3_PRESIGN_ENDPOINT ?? 'http://localhost:19000';
const bucket = process.env.S3_BUCKET ?? 'sovara-uploads';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://sovara_runtime:sovara_runtime@localhost:15432/sovara';
const appOrigin = 'http://localhost:18080';
const authSecret = process.env.AUTH_SECRET ?? 'local-compose-auth-secret-that-is-at-least-32-bytes';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ownerEmail = `compose-upload-${suffix}@example.com`;
const ownerPassword = `Compose-${randomUUID()}-password`;

let database: ReturnType<typeof createDatabase> | undefined;
let ownerId: string | undefined;
let cookie: string | undefined;
let s3: S3Client | undefined;
let privateObjectKey: string | undefined;

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Origin: appOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
  });
}

describe('TASK-005 running Compose upload path', () => {
  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    const provisioningAuth = createAuth(database, {
      secret: authSecret,
      appOrigin,
      provisioning: true,
    });
    const provisioned = await provisioningAuth.api.signUpEmail({
      body: { email: ownerEmail, name: 'Compose Upload Owner', password: ownerPassword },
    });
    if (!provisioned.user) throw new Error('Compose smoke user was not created');
    ownerId = provisioned.user.id;
    s3 = new S3Client({
      endpoint: publicStorageUrl,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
  });

  afterAll(async () => {
    if (s3 && privateObjectKey)
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: privateObjectKey }));
    s3?.destroy();
    if (database && ownerId) {
      await database.pool.query(
        'DELETE FROM multipart_upload WHERE video_id IN (SELECT id FROM video WHERE user_id = $1)',
        [ownerId],
      );
      await database.pool.query('DELETE FROM video WHERE user_id = $1', [ownerId]);
      await database.pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
    }
    await database?.pool.end();
  });

  test('authenticates through the running API and PUTs to the returned URL unchanged', async () => {
    const login = await request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie');
    if (!setCookie) throw new Error('Compose API did not return an authentication cookie');
    cookie = setCookie.split(';', 1)[0];

    const create = await request('/api/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originalFilename: 'compose-smoke.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 5 * 1024 * 1024,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      videoId: string;
      upload: {
        uploadId: string;
        expectedPartCount: number;
        partSizeBytes: number;
        expectedSizeBytes: number;
        revision: number;
      };
    };
    expect(created.upload.expectedPartCount).toBe(1);

    const signed = await request(
      `/api/videos/${created.videoId}/uploads/${created.upload.uploadId}/part-urls`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ partNumbers: [1] }),
      },
    );
    expect(signed.status).toBe(200);
    const signedBody = (await signed.json()) as { parts: Array<{ url: string }> };
    const partUrl = signedBody.parts[0]?.url;
    if (!partUrl) throw new Error('Compose API did not return a presigned part URL');
    expect(new URL(partUrl).origin).toBe(publicStorageUrl);

    const preflight = await fetch(partUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: appOrigin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);

    const directPut = await fetch(partUrl, {
      method: 'PUT',
      headers: { Origin: appOrigin, 'Content-Type': 'video/mp4' },
      body: Buffer.alloc(created.upload.expectedSizeBytes, 7),
    });
    expect(directPut.status).toBe(200);
    const etag = directPut.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(directPut.headers.get('access-control-expose-headers')).toMatch(/etag/i);

    const unapprovedPreflight = await fetch(partUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://attacker.example',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(unapprovedPreflight.headers.get('access-control-allow-origin')).not.toBe(
      'http://attacker.example',
    );

    const recorded = await request(
      `/api/videos/${created.videoId}/uploads/${created.upload.uploadId}/parts/1`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ etag, reportedSizeBytes: created.upload.expectedSizeBytes }),
      },
    );
    expect(recorded.status).toBe(200);

    const aborted = await request(
      `/api/videos/${created.videoId}/uploads/${created.upload.uploadId}/abort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: created.upload.revision }),
      },
    );
    expect(aborted.status).toBe(200);

    privateObjectKey = `compose-private-${suffix}.txt`;
    await s3!.send(
      new PutObjectCommand({ Bucket: bucket, Key: privateObjectKey, Body: 'private' }),
    );
    const anonymousObject = await fetch(`${publicStorageUrl}/${bucket}/${privateObjectKey}`);
    expect([401, 403]).toContain(anonymousObject.status);
  });
});
