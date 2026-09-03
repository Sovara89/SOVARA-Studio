import { and, eq, gt, isNull } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { oauthTransaction } from '../schema/oauth-transactions.js';

type Database = ReturnType<typeof createDatabase>['db'];

export function createOAuthTransactionRepository(db: Database) {
  return {
    create: (values: typeof oauthTransaction.$inferInsert) =>
      db.insert(oauthTransaction).values(values).returning(),
    findUsable: (stateHash: string, platform: string, now: Date) =>
      db
        .select()
        .from(oauthTransaction)
        .where(
          and(
            eq(oauthTransaction.stateHash, stateHash),
            eq(oauthTransaction.platform, platform),
            gt(oauthTransaction.expiresAt, now),
            isNull(oauthTransaction.consumedAt),
          ),
        )
        .limit(1),
    consume: (id: string, now: Date) =>
      db
        .update(oauthTransaction)
        .set({ consumedAt: now })
        .where(and(eq(oauthTransaction.id, id), isNull(oauthTransaction.consumedAt)))
        .returning(),
  };
}
