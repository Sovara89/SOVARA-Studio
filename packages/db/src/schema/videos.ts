import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.generated.js';

export const videoStates = [
  'awaiting_upload',
  'uploading',
  'uploaded',
  'verifying',
  'ready',
  'invalid',
  'failed',
  'deletion_pending',
  'deleted',
] as const;
export type VideoState = (typeof videoStates)[number];

export const videoChecksumAlgorithms = ['sha256', 'sha1', 'crc32', 'crc32c', 'crc64nvme'] as const;
export type VideoChecksumAlgorithm = (typeof videoChecksumAlgorithms)[number];

export const video = pgTable(
  'video',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    expectedSizeBytes: bigint('expected_size_bytes', { mode: 'number' }).notNull(),
    verifiedSizeBytes: bigint('verified_size_bytes', { mode: 'number' }),
    storageBackend: text('storage_backend').notNull(),
    storageBucket: text('storage_bucket').notNull(),
    objectKey: text('object_key').notNull(),
    objectVersionId: text('object_version_id'),
    objectEtag: text('object_etag'),
    verifiedChecksumAlgorithm: text('verified_checksum_algorithm'),
    verifiedChecksumValue: text('verified_checksum_value'),
    state: text('state').default('awaiting_upload').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    revision: integer('revision').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('video_id_userId_key').on(table.id, table.userId),
    uniqueIndex('video_storage_tuple_uidx').on(
      table.storageBackend,
      table.storageBucket,
      table.objectKey,
    ),
    index('video_userId_createdAt_idx').on(table.userId, table.createdAt),
    index('video_userId_state_updatedAt_idx').on(table.userId, table.state, table.updatedAt),
    index('video_attention_idx')
      .on(table.state, table.updatedAt)
      .where(sql`${table.state} IN ('uploaded', 'verifying', 'deletion_pending')`),
    check('video_original_filename_check', sql`length(trim(${table.originalFilename})) > 0`),
    check('video_content_type_check', sql`length(trim(${table.contentType})) > 0`),
    check('video_expected_size_check', sql`${table.expectedSizeBytes} > 0`),
    check(
      'video_verified_size_check',
      sql`${table.verifiedSizeBytes} IS NULL OR ${table.verifiedSizeBytes} >= 0`,
    ),
    check(
      'video_storage_identity_check',
      sql`length(trim(${table.storageBackend})) > 0 AND length(trim(${table.storageBucket})) > 0 AND length(trim(${table.objectKey})) > 0`,
    ),
    check(
      'video_checksum_pair_check',
      sql`(${table.verifiedChecksumAlgorithm} IS NULL AND ${table.verifiedChecksumValue} IS NULL) OR (${table.verifiedChecksumAlgorithm} IS NOT NULL AND ${table.verifiedChecksumValue} IS NOT NULL AND length(trim(${table.verifiedChecksumValue})) > 0)`,
    ),
    check(
      'video_checksum_algorithm_check',
      sql`${table.verifiedChecksumAlgorithm} IS NULL OR ${table.verifiedChecksumAlgorithm} IN ('sha256', 'sha1', 'crc32', 'crc32c', 'crc64nvme')`,
    ),
    check(
      'video_state_check',
      sql`${table.state} IN ('awaiting_upload', 'uploading', 'uploaded', 'verifying', 'ready', 'invalid', 'failed', 'deletion_pending', 'deleted')`,
    ),
    check('video_revision_check', sql`${table.revision} >= 0`),
    check(
      'video_ready_check',
      sql`${table.state} <> 'ready' OR (${table.verifiedAt} IS NOT NULL AND ${table.verifiedSizeBytes} = ${table.expectedSizeBytes} AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)`,
    ),
    check(
      'video_invalid_check',
      sql`${table.state} <> 'invalid' OR (${table.verifiedAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL)`,
    ),
    check(
      'video_failed_check',
      sql`${table.state} <> 'failed' OR ${table.failureCode} IS NOT NULL`,
    ),
    check(
      'video_failure_pair_check',
      sql`${table.failureMessage} IS NULL OR ${table.failureCode} IS NOT NULL`,
    ),
    check(
      'video_deleted_check',
      sql`${table.state} NOT IN ('deletion_pending', 'deleted') OR ${table.deletionRequestedAt} IS NOT NULL`,
    ),
    check(
      'video_deleted_at_check',
      sql`${table.state} <> 'deleted' OR ${table.deletedAt} IS NOT NULL`,
    ),
    check(
      'video_deleted_timestamp_check',
      sql`${table.state} <> 'deletion_pending' OR ${table.deletedAt} IS NULL`,
    ),
  ],
);
