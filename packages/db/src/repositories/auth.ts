import { and, eq } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { account, session, user } from '../schema/auth.generated.js';

type Database = ReturnType<typeof createDatabase>['db'];

export function findUserByEmail(db: Database, email: string) {
  return db.select().from(user).where(eq(user.email, email)).limit(1);
}

export function findCredentialAccount(db: Database, userId: string) {
  return db
    .select()
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, 'credential'),
        eq(account.issuer, 'local:credential'),
      ),
    )
    .limit(1);
}

export function findSessionsForUser(db: Database, userId: string) {
  return db.select().from(session).where(eq(session.userId, userId));
}
