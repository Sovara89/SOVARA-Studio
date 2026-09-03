import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { publishingAccount } from './publishing-accounts.js';
import { video } from './videos.js';

export const publicationIntent = pgTable(
  'publication_intent',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id').notNull(),
    videoId: uuid('video_id').notNull(),
    publishingAccountId: uuid('publishing_account_id').notNull(),
    platform: text('platform').notNull(),
    mode: text('mode').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    link: text('link'),
    createCommunityPost: boolean('create_community_post').notNull().default(false),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    previewObjectKey: text('preview_object_key'),
    previewContentType: text('preview_content_type'),
    previewSizeBytes: bigint('preview_size_bytes', { mode: 'number' }),
    previewState: text('preview_state'),
    pendingPreviewObjectKey: text('pending_preview_object_key'),
    pendingPreviewContentType: text('pending_preview_content_type'),
    pendingPreviewSizeBytes: bigint('pending_preview_size_bytes', { mode: 'number' }),
    revision: integer('revision').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publication_intent_video_account_uidx').on(
      table.videoId,
      table.publishingAccountId,
    ),
    index('publication_intent_user_updated_idx').on(table.userId, table.updatedAt),
    foreignKey({
      columns: [table.videoId, table.userId],
      foreignColumns: [video.id, video.userId],
      name: 'publication_intent_video_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.publishingAccountId, table.userId, table.platform],
      foreignColumns: [publishingAccount.id, publishingAccount.userId, publishingAccount.platform],
      name: 'publication_intent_account_user_platform_fk',
    }).onDelete('restrict'),
    check('publication_intent_platform_check', sql`${table.platform} IN ('youtube', 'vk')`),
    check(
      'publication_intent_mode_check',
      sql`${table.mode} IN ('DRAFT', 'PUBLISH_NOW', 'SCHEDULED')`,
    ),
    check(
      'publication_intent_title_check',
      sql`length(trim(${table.title})) > 0 AND length(${table.title}) <= 100`,
    ),
    check(
      'publication_intent_vk_description_check',
      sql`${table.platform} <> 'vk' OR ${table.description} IS NULL OR length(${table.description}) <= 5000`,
    ),
    check(
      'publication_intent_schedule_check',
      sql`(${table.mode} = 'SCHEDULED' AND ${table.scheduledAt} IS NOT NULL) OR (${table.mode} <> 'SCHEDULED' AND ${table.scheduledAt} IS NULL)`,
    ),
    check(
      'publication_intent_preview_check',
      sql`(${table.previewObjectKey} IS NULL AND ${table.previewContentType} IS NULL AND ${table.previewSizeBytes} IS NULL AND ${table.previewState} IS NULL) OR (${table.previewObjectKey} IS NOT NULL AND ${table.previewContentType} IN ('image/jpeg', 'image/png', 'image/webp') AND ${table.previewSizeBytes} > 0 AND ${table.previewState} IN ('pending', 'ready'))`,
    ),
    check(
      'publication_intent_pending_preview_check',
      sql`(${table.pendingPreviewObjectKey} IS NULL AND ${table.pendingPreviewContentType} IS NULL AND ${table.pendingPreviewSizeBytes} IS NULL) OR (${table.previewState} = 'ready' AND ${table.previewObjectKey} IS NOT NULL AND ${table.pendingPreviewObjectKey} IS NOT NULL AND ${table.pendingPreviewContentType} IN ('image/jpeg', 'image/png', 'image/webp') AND ${table.pendingPreviewSizeBytes} > 0)`,
    ),
    check('publication_intent_revision_check', sql`${table.revision} >= 0`),
  ],
);
