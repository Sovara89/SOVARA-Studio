import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { publishingAccount } from './publishing-accounts.js';
import { video } from './videos.js';

export const publicationStates = [
  'queued',
  'publishing',
  'reconciling',
  'retry_wait',
  'manual_review',
  'published',
  'failed',
  'cancelled',
] as const;
export type PublicationState = (typeof publicationStates)[number];

export const publicationAttemptStates = [
  'started',
  'request_sent',
  'succeeded',
  'definitely_failed',
  'ambiguous',
  'reconciled_succeeded',
  'reconciled_absent',
  'manual_review',
] as const;
export type PublicationAttemptState = (typeof publicationAttemptStates)[number];

export const publication = pgTable(
  'publication',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id').notNull(),
    videoId: uuid('video_id').notNull(),
    publishingAccountId: uuid('publishing_account_id').notNull(),
    platform: text('platform').notNull(),
    state: text('state').default('queued').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    metadataVersion: smallint('metadata_version').default(1).notNull(),
    metadata: jsonb('metadata')
      .default(sql`'{}'::jsonb`)
      .notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    remoteOwnerId: text('remote_owner_id'),
    remoteMediaId: text('remote_media_id'),
    remoteUrl: text('remote_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    reconciliationRequiredAt: timestamp('reconciliation_required_at', { withTimezone: true }),
    failureClass: text('failure_class'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    revision: integer('revision').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('publication_id_userId_key').on(table.id, table.userId),
    uniqueIndex('publication_video_account_uidx').on(table.videoId, table.publishingAccountId),
    uniqueIndex('publication_platform_remoteMediaId_uidx')
      .on(table.platform, table.remoteMediaId)
      .where(sql`${table.platform} = 'youtube' AND ${table.remoteMediaId} IS NOT NULL`),
    uniqueIndex('publication_vk_remoteOwnerId_remoteMediaId_uidx')
      .on(table.platform, table.remoteOwnerId, table.remoteMediaId)
      .where(
        sql`${table.platform} = 'vk' AND ${table.remoteOwnerId} IS NOT NULL AND ${table.remoteMediaId} IS NOT NULL`,
      ),
    index('publication_userId_videoId_idx').on(table.userId, table.videoId),
    index('publication_userId_state_updatedAt_idx').on(table.userId, table.state, table.updatedAt),
    index('publication_work_idx')
      .on(table.state, table.nextAttemptAt)
      .where(sql`${table.state} IN ('queued', 'retry_wait')`),
    index('publication_lease_idx')
      .on(table.state, table.leaseExpiresAt)
      .where(sql`${table.state} IN ('publishing', 'reconciling')`),
    foreignKey({
      columns: [table.videoId, table.userId],
      foreignColumns: [video.id, video.userId],
      name: 'publication_video_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.publishingAccountId, table.userId, table.platform],
      foreignColumns: [publishingAccount.id, publishingAccount.userId, publishingAccount.platform],
      name: 'publication_publishing_account_user_platform_fk',
    }).onDelete('restrict'),
    check('publication_platform_check', sql`${table.platform} IN ('youtube', 'vk')`),
    check(
      'publication_state_check',
      sql`${table.state} IN ('queued', 'publishing', 'reconciling', 'retry_wait', 'manual_review', 'published', 'failed', 'cancelled')`,
    ),
    check('publication_title_check', sql`length(trim(${table.title})) > 0`),
    check('publication_metadata_version_check', sql`${table.metadataVersion} > 0`),
    check('publication_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('publication_revision_check', sql`${table.revision} >= 0`),
    check(
      'publication_lease_pair_check',
      sql`(${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      'publication_retry_check',
      sql`${table.state} <> 'retry_wait' OR ${table.nextAttemptAt} IS NOT NULL`,
    ),
    check(
      'publication_reconcile_check',
      sql`${table.state} <> 'reconciling' OR ${table.reconciliationRequiredAt} IS NOT NULL`,
    ),
    check(
      'publication_published_check',
      sql`${table.state} <> 'published' OR (${table.publishedAt} IS NOT NULL AND ${table.remoteMediaId} IS NOT NULL AND ((${table.platform} = 'youtube' AND ${table.remoteOwnerId} IS NULL) OR (${table.platform} = 'vk' AND ${table.remoteOwnerId} IS NOT NULL)))`,
    ),
    check(
      'publication_remote_identity_check',
      sql`${table.remoteOwnerId} IS NULL OR ${table.platform} = 'vk'`,
    ),
    check(
      'publication_remote_owner_id_check',
      sql`${table.remoteOwnerId} IS NULL OR length(trim(${table.remoteOwnerId})) > 0`,
    ),
    check(
      'publication_remote_media_id_check',
      sql`${table.remoteMediaId} IS NULL OR length(trim(${table.remoteMediaId})) > 0`,
    ),
    check(
      'publication_remote_identity_pair_check',
      sql`${table.remoteOwnerId} IS NULL OR ${table.remoteMediaId} IS NOT NULL`,
    ),
    check(
      'publication_failure_pair_check',
      sql`${table.failureMessage} IS NULL OR ${table.failureCode} IS NOT NULL`,
    ),
  ],
);

export const publicationAttempt = pgTable(
  'publication_attempt',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    publicationId: uuid('publication_id').notNull(),
    userId: uuid('user_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    state: text('state').notNull(),
    providerRequestId: text('provider_request_id'),
    remoteMediaId: text('remote_media_id'),
    remoteUrl: text('remote_url'),
    failureClass: text('failure_class'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    requestSentAt: timestamp('request_sent_at', { withTimezone: true }),
    reconciliationCheckedAt: timestamp('reconciliation_checked_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    revision: integer('revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    remoteOwnerId: text('remote_owner_id'),
  },
  (table) => [
    unique('publication_attempt_id_userId_key').on(table.id, table.userId),
    uniqueIndex('publication_attempt_publication_number_uidx').on(
      table.publicationId,
      table.attemptNumber,
    ),
    index('publication_attempt_userId_publicationId_idx').on(table.userId, table.publicationId),
    index('publication_attempt_state_startedAt_idx').on(table.state, table.startedAt),
    foreignKey({
      columns: [table.publicationId, table.userId],
      foreignColumns: [publication.id, publication.userId],
      name: 'publication_attempt_publication_user_fk',
    }).onDelete('cascade'),
    check(
      'publication_attempt_state_check',
      sql`${table.state} IN ('started', 'request_sent', 'succeeded', 'definitely_failed', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'manual_review')`,
    ),
    check('publication_attempt_number_check', sql`${table.attemptNumber} > 0`),
    check('publication_attempt_revision_check', sql`${table.revision} >= 0`),
    check(
      'publication_attempt_request_sent_check',
      sql`${table.state} NOT IN ('request_sent', 'succeeded', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'manual_review') OR ${table.requestSentAt} IS NOT NULL`,
    ),
    check(
      'publication_attempt_success_check',
      sql`${table.state} NOT IN ('succeeded', 'reconciled_succeeded') OR ${table.remoteMediaId} IS NOT NULL`,
    ),
    check(
      'publication_attempt_remote_identity_pair_check',
      sql`${table.remoteOwnerId} IS NULL OR ${table.remoteMediaId} IS NOT NULL`,
    ),
    check(
      'publication_attempt_remote_owner_id_check',
      sql`${table.remoteOwnerId} IS NULL OR length(trim(${table.remoteOwnerId})) > 0`,
    ),
    check(
      'publication_attempt_remote_media_id_check',
      sql`${table.remoteMediaId} IS NULL OR length(trim(${table.remoteMediaId})) > 0`,
    ),
    check(
      'publication_attempt_terminal_time_check',
      sql`${table.state} NOT IN ('succeeded', 'definitely_failed', 'reconciled_succeeded', 'reconciled_absent') OR ${table.finishedAt} IS NOT NULL`,
    ),
    check(
      'publication_attempt_failure_pair_check',
      sql`${table.failureMessage} IS NULL OR ${table.failureCode} IS NOT NULL`,
    ),
  ],
);
