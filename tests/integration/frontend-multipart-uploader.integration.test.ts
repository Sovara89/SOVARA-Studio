import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase } from '../../packages/db/src/index.js';
import { createAuth } from '../../apps/api/src/auth/options.js';
import { createUploadApi } from '../../apps/web/src/lib/upload-api';
import {
  UploadCoordinator,
  type UploadTransport,
} from '../../apps/web/src/features/uploads/upload-coordinator';

const apiUrl = process.env.TEST_COMPOSE_API_URL ?? 'http://localhost:13000';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://sovara_runtime:sovara_runtime@localhost:15432/sovara';
const appOrigin = 'http://localhost:18080';
const authSecret = process.env.AUTH_SECRET ?? 'local-compose-auth-secret-that-is-at-least-32-bytes';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const email = `frontend-uploader-${suffix}@example.com`;
const password = `Frontend-${randomUUID()}-password`;

let database: ReturnType<typeof createDatabase> | undefined;
let ownerId: string | undefined;

describe('TASK-006 frontend multipart uploader against Compose', () => {
  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    const auth = createAuth(database, { secret: authSecret, appOrigin, provisioning: true });
    const created = await auth.api.signUpEmail({
      body: { email, name: 'Frontend Uploader', password },
    });
    if (!created.user) throw new Error('Integration user was not created');
    ownerId = created.user.id;
  });

  afterAll(async () => {
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

  test('creates a session, signs, PUTs directly, and records the part', async () => {
    const login = await fetch(`${apiUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { Origin: appOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('Integration login did not return a cookie');
    const apiRequests: Array<{ path: string; method: string; body?: unknown }> = [];
    const signingBatches: number[][] = [];
    const api = createUploadApi({
      baseUrl: `${apiUrl}/api`,
      headers: { Origin: appOrigin, Cookie: cookie },
      fetchImpl: async (input, init) => {
        const requestUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(requestUrl).pathname;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        apiRequests.push({ path, method: init?.method ?? 'GET', body });
        if (path.endsWith('/part-urls')) {
          const partNumbers = (body as { partNumbers: number[] }).partNumbers;
          signingBatches.push(partNumbers);
        }
        return fetch(input, init);
      },
    });
    const etags: string[] = [];
    const transport: UploadTransport = async ({ url, body, signal, onProgress }) => {
      const response = await fetch(url, {
        method: 'PUT',
        body,
        signal,
        headers: { Origin: appOrigin, 'Content-Type': body.type || 'video/mp4' },
      });
      onProgress(body.size, body.size);
      if (!response.ok) throw new Error(`Direct PUT failed (${response.status})`);
      const etag = response.headers.get('etag');
      if (!etag) throw new Error('Direct PUT did not return an ETag');
      etags.push(etag);
      return { etag };
    };
    const coordinator = new UploadCoordinator({
      api,
      transport,
      sessions: { load: () => null, save: () => undefined, clear: () => undefined },
      policy: { maxConcurrency: 2, signingWindow: 4 },
    });
    const file = new File([Buffer.alloc(130 * 1024 * 1024, 3)], 'frontend.mp4', {
      type: 'video/mp4',
    });
    await coordinator.start(file);
    expect(coordinator.getState().status?.expectedPartCount).toBeGreaterThan(1);
    expect(coordinator.getState().phase).toBe('all_parts_recorded');
    expect(coordinator.getState().confirmedBytes).toBe(file.size);
    const { videoId, uploadId } = statusFromState(coordinator);
    const authoritative = await api.getStatus(videoId, uploadId);
    const expectedPartNumbers = Array.from(
      { length: authoritative.expectedPartCount },
      (_, index) => index + 1,
    );
    expect(authoritative.parts.map((part) => part.partNumber).sort((a, b) => a - b)).toEqual(
      expectedPartNumbers,
    );
    expect(signingBatches.length).toBeGreaterThan(0);
    expect(Math.max(...signingBatches.map((batch) => batch.length))).toBeLessThanOrEqual(4);
    expect(Math.max(...signingBatches.map((batch) => batch.length))).toBeLessThanOrEqual(
      Number(process.env.UPLOAD_SIGN_BATCH_MAX ?? 16),
    );
    expect(signingBatches.flat()).toEqual(expect.arrayContaining(expectedPartNumbers));
    expect(new Set(signingBatches.flat()).size).toBe(expectedPartNumbers.length);
    expect(etags).toHaveLength(expectedPartNumbers.length);
    expect(
      apiRequests.some(({ path, method }) => method === 'POST' && path.endsWith('/complete')),
    ).toBe(false);
    const completion = await api.complete(videoId, uploadId, authoritative.revision);
    expect(completion.outcome).toBe('ready');
    expect(completion.videoState).toBe('ready');
    expect((await api.getStatus(videoId, uploadId)).state).toBe('completed');
  }, 30_000);
});

function statusFromState(coordinator: UploadCoordinator) {
  const state = coordinator.getState();
  if (!state.status) throw new Error('Upload coordinator has no upload status');
  return { videoId: state.status.videoId, uploadId: state.status.uploadId };
}
