import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { video } from './videos.js';

export const multipartUploadStates = [
  'initiating',
  'initiation_reconciling',
  'active',
  'completing',
  'completed',
  'abort_pending',
  'aborted',
  'expired',
  'failed',
] as const;
export type MultipartUploadState = (typeof multipartUploadStates)[number];

export const multipartUpload = pgTable(
  'multipart_upload',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id').notNull(),
    videoId: uuid('video_id').notNull(),
    providerUploadId: text('provider_upload_id'),
    partSizeBytes: bigint('part_size_bytes', { mode: 'number' }).notNull(),
    expectedPartCount: integer('expected_part_count').notNull(),
    state: text('state').default('active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completionRequestedAt: timestamp('completion_requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    revision: integer('revision').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('multipart_upload_id_userId_key').on(table.id, table.userId),
    uniqueIndex('multipart_upload_video_providerUploadId_uidx').on(
      table.videoId,
      table.providerUploadId,
    ),
    uniqueIndex('multipart_upload_unresolved_video_uidx')
      .on(table.videoId)
      .where(
        sql`${table.state} IN ('initiating', 'initiation_reconciling', 'active', 'completing', 'abort_pending', 'failed')`,
      ),
    index('multipart_upload_userId_state_expiresAt_idx').on(
      table.userId,
      table.state,
      table.expiresAt,
    ),
    index('multipart_upload_videoId_createdAt_idx').on(table.videoId, table.createdAt),
    foreignKey({
      columns: [table.videoId, table.userId],
      foreignColumns: [video.id, video.userId],
      name: 'multipart_upload_video_user_fk',
    }).onDelete('restrict'),
    check(
      'multipart_upload_provider_id_check',
      sql`${table.providerUploadId} IS NULL OR length(trim(${table.providerUploadId})) > 0`,
    ),
    check('multipart_upload_part_size_check', sql`${table.partSizeBytes} > 0`),
    check('multipart_upload_part_count_check', sql`${table.expectedPartCount} BETWEEN 1 AND 10000`),
    check(
      'multipart_upload_state_check',
      sql`${table.state} IN ('initiating', 'initiation_reconciling', 'active', 'completing', 'completed', 'abort_pending', 'aborted', 'expired', 'failed')`,
    ),
    check('multipart_upload_revision_check', sql`${table.revision} >= 0`),
    check(
      'multipart_upload_completion_check',
      sql`${table.state} <> 'completing' OR ${table.completionRequestedAt} IS NOT NULL`,
    ),
    check(
      'multipart_upload_completed_check',
      sql`${table.state} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
    check(
      'multipart_upload_closed_check',
      sql`${table.state} NOT IN ('aborted', 'expired') OR ${table.closedAt} IS NOT NULL`,
    ),
    check(
      'multipart_upload_failure_pair_check',
      sql`${table.failureMessage} IS NULL OR ${table.failureCode} IS NOT NULL`,
    ),
  ],
);

export const uploadPart = pgTable(
  'upload_part',
  {
    multipartUploadId: uuid('multipart_upload_id').notNull(),
    userId: uuid('user_id').notNull(),
    partNumber: integer('part_number').notNull(),
    etag: text('etag').notNull(),
    reportedSizeBytes: bigint('reported_size_bytes', { mode: 'number' }),
    providerChecksumAlgorithm: text('provider_checksum_algorithm'),
    providerChecksumValue: text('provider_checksum_value'),
    revision: integer('revision').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.multipartUploadId, table.partNumber] }),
    index('upload_part_userId_uploadId_idx').on(table.userId, table.multipartUploadId),
    foreignKey({
      columns: [table.multipartUploadId, table.userId],
      foreignColumns: [multipartUpload.id, multipartUpload.userId],
      name: 'upload_part_upload_user_fk',
    }).onDelete('cascade'),
    check('upload_part_number_check', sql`${table.partNumber} BETWEEN 1 AND 10000`),
    check('upload_part_etag_check', sql`length(trim(${table.etag})) > 0`),
    check(
      'upload_part_size_check',
      sql`${table.reportedSizeBytes} IS NULL OR ${table.reportedSizeBytes} > 0`,
    ),
    check(
      'upload_part_checksum_pair_check',
      sql`(${table.providerChecksumAlgorithm} IS NULL AND ${table.providerChecksumValue} IS NULL) OR (${table.providerChecksumAlgorithm} IS NOT NULL AND ${table.providerChecksumValue} IS NOT NULL AND length(trim(${table.providerChecksumValue})) > 0)`,
    ),
    check(
      'upload_part_checksum_algorithm_check',
      sql`${table.providerChecksumAlgorithm} IS NULL OR ${table.providerChecksumAlgorithm} IN ('sha256', 'sha1', 'crc32', 'crc32c', 'crc64nvme')`,
    ),
    check('upload_part_revision_check', sql`${table.revision} >= 0`),
  ],
);

export type UploadPart = typeof uploadPart.$inferSelect;
