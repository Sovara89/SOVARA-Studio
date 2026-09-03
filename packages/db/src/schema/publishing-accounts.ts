import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.generated.js';

export const publishingAccount = pgTable(
  'publishing_account',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    providerAccountId: text('provider_account_id'),
    displayName: text('display_name'),
    accessTokenCiphertext: text('access_token_ciphertext'),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    scopes: text('scopes')
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    credentialFormatVersion: smallint('credential_format_version'),
    credentialKeyId: text('credential_key_id'),
    credentialUpdatedAt: timestamp('credential_updated_at', { withTimezone: true }),
    credentialRevision: integer('credential_revision').default(0).notNull(),
    refreshLeaseToken: uuid('refresh_lease_token'),
    refreshLeaseExpiresAt: timestamp('refresh_lease_expires_at', { withTimezone: true }),
    providerDeviceIdCiphertext: text('provider_device_id_ciphertext'),
    status: text('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('publishing_account_userId_idx').on(table.userId),
    index('publishing_account_userId_platform_idx').on(table.userId, table.platform),
    index('publishing_account_userId_status_idx').on(table.userId, table.status),
    unique('publishing_account_id_userId_platform_key').on(table.id, table.userId, table.platform),
    uniqueIndex('publishing_account_platform_providerAccountId_uidx')
      .on(table.platform, table.providerAccountId)
      .where(sql`${table.providerAccountId} IS NOT NULL`),
    check('publishing_account_platform_check', sql`${table.platform} IN ('youtube', 'vk')`),
    check(
      'publishing_account_status_check',
      sql`${table.status} IN ('pending', 'active', 'reauthorization_required', 'revoked')`,
    ),
    check('publishing_account_revision_check', sql`${table.credentialRevision} >= 0`),
    check(
      'publishing_account_refresh_lease_pair_check',
      sql`(${table.refreshLeaseToken} IS NULL AND ${table.refreshLeaseExpiresAt} IS NULL) OR (${table.refreshLeaseToken} IS NOT NULL AND ${table.refreshLeaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      'publishing_account_active_credentials_check',
      sql`${table.status} <> 'active' OR (${table.providerAccountId} IS NOT NULL AND ${table.accessTokenCiphertext} IS NOT NULL AND ${table.credentialFormatVersion} IS NOT NULL AND ${table.credentialKeyId} IS NOT NULL AND ${table.credentialUpdatedAt} IS NOT NULL)`,
    ),
  ],
);
