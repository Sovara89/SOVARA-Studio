import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { session, user } from './auth.generated.js';

export const oauthTransaction = pgTable(
  'oauth_transaction',
  {
    id: uuid('id')
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    stateHash: text('state_hash').notNull().unique(),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    publishingAccountId: uuid('publishing_account_id'),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes')
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('oauth_transaction_userId_idx').on(table.userId),
    index('oauth_transaction_expiresAt_idx').on(table.expiresAt),
    check('oauth_transaction_platform_check', sql`${table.platform} IN ('youtube', 'vk')`),
  ],
);
