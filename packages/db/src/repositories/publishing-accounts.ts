import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { createDatabase } from '../client.js';
import { publishingAccount } from '../schema/publishing-accounts.js';

type Database = ReturnType<typeof createDatabase>['db'];
export type CredentialUpdate = Partial<
  Pick<
    typeof publishingAccount.$inferInsert,
    | 'displayName'
    | 'providerAccountId'
    | 'accessTokenCiphertext'
    | 'refreshTokenCiphertext'
    | 'accessTokenExpiresAt'
    | 'scopes'
    | 'credentialFormatVersion'
    | 'credentialKeyId'
    | 'credentialUpdatedAt'
    | 'status'
    | 'providerDeviceIdCiphertext'
  >
>;

export function createPublishingAccountRepository(db: Database) {
  return {
    findByIdForUser: (userId: string, id: string) =>
      db
        .select()
        .from(publishingAccount)
        .where(and(eq(publishingAccount.userId, userId), eq(publishingAccount.id, id)))
        .limit(1),
    listForUser: (userId: string) =>
      db.select().from(publishingAccount).where(eq(publishingAccount.userId, userId)),
    updateCredentialRevision: async (
      userId: string,
      id: string,
      revision: number,
      values: CredentialUpdate,
    ) =>
      db
        .update(publishingAccount)
        .set({ ...values, credentialRevision: revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(publishingAccount.userId, userId),
            eq(publishingAccount.id, id),
            eq(publishingAccount.credentialRevision, revision),
          ),
        )
        .returning(),
    acquireRefreshLease: async (
      id: string,
      userId: string,
      platform: string,
      expectedRevision: number,
      now: Date,
      leaseMs: number,
    ) => {
      const leaseToken = randomUUID();
      const rows = await db
        .update(publishingAccount)
        .set({
          refreshLeaseToken: leaseToken,
          refreshLeaseExpiresAt: new Date(now.getTime() + leaseMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(publishingAccount.id, id),
            eq(publishingAccount.userId, userId),
            eq(publishingAccount.platform, platform),
            eq(publishingAccount.credentialRevision, expectedRevision),
            eq(publishingAccount.status, 'active'),
            sql`${publishingAccount.refreshTokenCiphertext} IS NOT NULL`,
            or(
              isNull(publishingAccount.refreshLeaseExpiresAt),
              lt(publishingAccount.refreshLeaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      return rows[0] ? { account: rows[0], leaseToken } : null;
    },
    persistRefresh: async (
      id: string,
      revision: number,
      leaseToken: string,
      values: CredentialUpdate & { providerDeviceIdCiphertext?: string | null },
    ) =>
      db
        .update(publishingAccount)
        .set({
          ...values,
          credentialRevision: revision + 1,
          refreshLeaseToken: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publishingAccount.id, id),
            eq(publishingAccount.credentialRevision, revision),
            eq(publishingAccount.refreshLeaseToken, leaseToken),
          ),
        )
        .returning(),
    markRefreshReauthorization: (id: string, revision: number, leaseToken: string) =>
      db
        .update(publishingAccount)
        .set({
          status: 'reauthorization_required',
          credentialRevision: revision + 1,
          refreshLeaseToken: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publishingAccount.id, id),
            eq(publishingAccount.credentialRevision, revision),
            eq(publishingAccount.refreshLeaseToken, leaseToken),
          ),
        )
        .returning(),
    settleReconnect: (input: {
      accountId: string;
      userId: string;
      platform: string;
      providerAccountId: string;
      expectedCredentialRevision: number;
      expectedStatus: string;
      values: CredentialUpdate;
    }) =>
      db
        .update(publishingAccount)
        .set({
          ...input.values,
          status: 'active',
          credentialRevision: input.expectedCredentialRevision + 1,
          refreshLeaseToken: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publishingAccount.id, input.accountId),
            eq(publishingAccount.userId, input.userId),
            eq(publishingAccount.platform, input.platform),
            eq(publishingAccount.providerAccountId, input.providerAccountId),
            eq(publishingAccount.credentialRevision, input.expectedCredentialRevision),
            eq(publishingAccount.status, input.expectedStatus),
          ),
        )
        .returning(),
    findByProviderIdentity: (platform: string, providerAccountId: string) =>
      db
        .select()
        .from(publishingAccount)
        .where(
          and(
            eq(publishingAccount.platform, platform),
            eq(publishingAccount.providerAccountId, providerAccountId),
          ),
        )
        .limit(1),
    connect: async (values: typeof publishingAccount.$inferInsert, existingId?: string) =>
      db.transaction(async (tx) => {
        const existingByProvider = await tx
          .select()
          .from(publishingAccount)
          .where(
            and(
              eq(publishingAccount.platform, values.platform),
              eq(publishingAccount.providerAccountId, values.providerAccountId!),
            ),
          )
          .limit(1);
        const existingById = existingId
          ? await tx
              .select()
              .from(publishingAccount)
              .where(eq(publishingAccount.id, existingId))
              .limit(1)
          : [];
        const existing = existingByProvider[0] ?? existingById[0];
        if (existing && existing.userId !== values.userId)
          throw new Error('Provider account is already connected to another Studio user');
        if (existing) {
          return tx
            .update(publishingAccount)
            .set({
              ...values,
              credentialRevision: existing.credentialRevision + 1,
              refreshLeaseToken: null,
              refreshLeaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(publishingAccount.id, existing.id))
            .returning();
        }
        return tx.insert(publishingAccount).values(values).returning();
      }),
    disconnect: (userId: string, id: string, expectedRevision: number) =>
      db
        .update(publishingAccount)
        .set({
          accessTokenCiphertext: null,
          refreshTokenCiphertext: null,
          accessTokenExpiresAt: null,
          providerDeviceIdCiphertext: null,
          scopes: [],
          credentialFormatVersion: null,
          credentialKeyId: null,
          credentialUpdatedAt: null,
          refreshLeaseToken: null,
          refreshLeaseExpiresAt: null,
          status: 'revoked',
          credentialRevision: sql`${publishingAccount.credentialRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publishingAccount.userId, userId),
            eq(publishingAccount.id, id),
            eq(publishingAccount.credentialRevision, expectedRevision),
          ),
        )
        .returning(),
    releaseRefreshLease: (id: string, leaseToken: string) =>
      db
        .update(publishingAccount)
        .set({ refreshLeaseToken: null, refreshLeaseExpiresAt: null, updatedAt: new Date() })
        .where(
          and(eq(publishingAccount.id, id), eq(publishingAccount.refreshLeaseToken, leaseToken)),
        )
        .returning(),
  };
}
