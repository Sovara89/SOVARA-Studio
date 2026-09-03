import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for migration integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_migration_0002_${suffix}`;
const userId = randomUUID();
const vkAccountId = randomUUID();
const youtubeAccountId = randomUUID();
const vkVideoId = randomUUID();
const youtubeVideoId = randomUUID();
const vkPublicationId = randomUUID();
const youtubePublicationId = randomUUID();
let databaseUrl: string;
let client: Client | undefined;

async function executeMigration(index: string) {
  const sql = await readFile(resolve(`packages/db/drizzle/${index}`), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) await client!.query(statement);
  }
}

describe('migration 0002 legacy VK compatibility', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await executeMigration('0000_jittery_lifeguard.sql');
    await executeMigration('0001_youthful_shatterstar.sql');

    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Migration Owner', $2, true, now(), now())`,
      [userId, `migration-${suffix}@example.com`],
    );
    await client.query(
      `INSERT INTO publishing_account
         (id, user_id, platform, provider_account_id, display_name,
          access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, scopes,
          credential_format_version, credential_key_id, credential_updated_at,
          credential_revision, status, created_at, updated_at)
       VALUES
         ($1, $3, 'vk', '12345', 'VK user identity',
          'encrypted-access-vk', 'encrypted-refresh-vk', now() + interval '1 hour', ARRAY['video'],
          1, 'key-v1', now(), 7, 'active', now(), now()),
         ($2, $3, 'youtube', 'channel-user-1', 'YouTube channel identity',
          'encrypted-access-youtube', 'encrypted-refresh-youtube', now() + interval '1 hour', ARRAY['youtube.upload'],
          1, 'key-v1', now(), 3, 'active', now(), now())`,
      [vkAccountId, youtubeAccountId, userId],
    );
    await client.query(
      `INSERT INTO video
         (id, user_id, original_filename, content_type, expected_size_bytes,
          verified_size_bytes, storage_backend, storage_bucket, object_key, object_etag,
          state, verified_at, revision, created_at, updated_at)
       VALUES
         ($1, $3, 'vk.mp4', 'video/mp4', 10, 10, 's3', 'private-source', $4, 'etag-vk',
          'ready', now(), 1, now(), now()),
         ($2, $3, 'youtube.mp4', 'video/mp4', 10, 10, 's3', 'private-source', $5, 'etag-youtube',
          'ready', now(), 1, now(), now())`,
      [vkVideoId, youtubeVideoId, userId, `legacy-vk/${suffix}`, `legacy-yt/${suffix}`],
    );
    await client.query(
      `INSERT INTO publication
         (id, user_id, video_id, publishing_account_id, platform, state, title,
          remote_media_id, remote_url, published_at, revision, created_at, updated_at)
       VALUES
         ($1, $3, $4, $5, 'vk', 'published', 'Legacy VK', '777',
          'https://vk.com/video-54321_777', now(), 2, now(), now()),
         ($2, $3, $6, $7, 'youtube', 'published', 'Existing YouTube', 'video-00001',
          'https://youtu.be/video-00001', now(), 2, now(), now())`,
      [
        vkPublicationId,
        youtubePublicationId,
        userId,
        vkVideoId,
        vkAccountId,
        youtubeVideoId,
        youtubeAccountId,
      ],
    );
    await client.query(
      `INSERT INTO publication_attempt
         (publication_id, user_id, attempt_number, state, remote_media_id,
          request_sent_at, started_at, finished_at, revision, updated_at)
       VALUES
         ($1, $3, 1, 'succeeded', '777', now(), now(), now(), 1, now()),
         ($2, $3, 1, 'succeeded', 'video-00001', now(), now(), now(), 1, now())`,
      [vkPublicationId, youtubePublicationId, userId],
    );
  });

  afterAll(async () => {
    await client?.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  test('preserves credentials and USER identity while safely classifying unknown group TARGET', async () => {
    await executeMigration('0002_ancient_bloodstrike.sql');

    const vkPublication = await client!.query(
      `SELECT state, remote_owner_id, remote_media_id, published_at, failure_class, failure_code, revision
       FROM publication WHERE id = $1`,
      [vkPublicationId],
    );
    expect(vkPublication.rows[0]).toMatchObject({
      state: 'manual_review',
      remote_owner_id: null,
      remote_media_id: '777',
      failure_class: 'ambiguous',
      failure_code: 'VK_LEGACY_REMOTE_OWNER_UNVERIFIED',
      revision: 3,
    });
    expect(vkPublication.rows[0].published_at).toBeInstanceOf(Date);

    const vkAttempt = await client!.query(
      `SELECT state, remote_owner_id, remote_media_id, failure_class, failure_code, revision
       FROM publication_attempt WHERE publication_id = $1`,
      [vkPublicationId],
    );
    expect(vkAttempt.rows[0]).toMatchObject({
      state: 'manual_review',
      remote_owner_id: null,
      remote_media_id: '777',
      failure_class: 'ambiguous',
      failure_code: 'VK_LEGACY_REMOTE_OWNER_UNVERIFIED',
      revision: 2,
    });

    const vkAccount = await client!.query(
      `SELECT provider_account_id, access_token_ciphertext, refresh_token_ciphertext,
              credential_key_id, credential_revision
       FROM publishing_account WHERE id = $1`,
      [vkAccountId],
    );
    expect(vkAccount.rows[0]).toEqual({
      provider_account_id: '12345',
      access_token_ciphertext: 'encrypted-access-vk',
      refresh_token_ciphertext: 'encrypted-refresh-vk',
      credential_key_id: 'key-v1',
      credential_revision: 7,
    });
    expect(vkAccount.rows[0].provider_account_id).not.toBe('-54321');

    const youtubePublication = await client!.query(
      `SELECT state, remote_owner_id, remote_media_id, failure_code, revision
       FROM publication WHERE id = $1`,
      [youtubePublicationId],
    );
    expect(youtubePublication.rows[0]).toEqual({
      state: 'published',
      remote_owner_id: null,
      remote_media_id: 'video-00001',
      failure_code: null,
      revision: 2,
    });

    await executeMigration('0003_keen_wallflower.sql');
    await executeMigration('0004_illegal_ultron.sql');
    await executeMigration('0005_oval_argent.sql');
    await executeMigration('0006_misty_red_skull.sql');
  });
});
