import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { publishingAccount } from '../schema/publishing-accounts.js';
import { publication, publicationAttempt } from '../schema/publications.js';
import { video } from '../schema/videos.js';

type Database = ReturnType<typeof createDatabase>['db'];

export type PublicationPlatform = 'youtube' | 'vk';

export type CreatePublicationInput = {
  videoId: string;
  publishingAccountId: string;
  platform: PublicationPlatform;
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type DefinitiveFailureInput = {
  failureClass: string;
  failureCode: string;
  failureMessage?: string | null;
  retryable: boolean;
  nextAttemptAt?: Date;
};

export type ExpiredPublicationLeaseInput = {
  publicationId: string;
  expectedPublicationRevision: number;
  expectedLeaseToken: string;
  expectedAttemptId: string;
  expectedAttemptRevision: number;
  expectedAttemptState: 'started' | 'request_sent' | 'ambiguous';
  retryAt: Date;
};

export type PublicationLeaseOwnership = {
  expectedPublicationRevision: number;
  expectedLeaseToken: string;
};

export type PublicationRequestOwnership = PublicationLeaseOwnership & {
  publicationId: string;
  credential: {
    accountId: string;
    userId: string;
    platform: PublicationPlatform;
    credentialRevision: number;
  };
};

export type PublicationEvidenceOwnership = PublicationLeaseOwnership & {
  expectedPublicationState: 'publishing' | 'reconciling';
  expectedAttemptState: 'request_sent' | 'ambiguous';
};

export type AttemptEvidenceInput = {
  providerRequestId?: string | null;
  remoteOwnerId?: string | null;
  remoteMediaId?: string | null;
  remoteUrl?: string | null;
};

function assertCanonicalRemoteUrl(value: string | null | undefined) {
  if (value === null || value === undefined) return;
  if (value.length > 2048 || value.trim() !== value) throw new Error('Remote URL is unsafe');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Remote URL is malformed');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ip = isIP(hostname);
  const privateIpv4 =
    ip === 4 &&
    (() => {
      const octets = hostname.split('.').map(Number);
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
      const [first, second] = octets;
      if (first === undefined || second === undefined) return false;
      return (
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      );
    })();
  if (
    parsed.protocol !== 'https:' ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    (parsed.port && parsed.port !== '443') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    privateIpv4 ||
    ip === 6
  )
    throw new Error('Remote URL is unsafe');
  if (parsed.toString() !== value) throw new Error('Remote URL is not canonical');
}

function normalizedEvidence(input: unknown): AttemptEvidenceInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Attempt evidence must be an object');
  const allowed = new Set(['providerRequestId', 'remoteOwnerId', 'remoteMediaId', 'remoteUrl']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported attempt evidence key: ${key}`);
  }
  const source = input as Record<string, unknown>;
  const output: AttemptEvidenceInput = {};
  for (const key of ['providerRequestId', 'remoteOwnerId', 'remoteMediaId', 'remoteUrl'] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value !== null && value !== undefined && typeof value !== 'string')
      throw new Error(`Invalid attempt evidence value: ${key}`);
    if (
      typeof value === 'string' &&
      (value.length > 2048 || value.trim() !== value || value === '')
    )
      throw new Error(`Invalid attempt evidence value: ${key}`);
    if (key === 'remoteUrl') assertCanonicalRemoteUrl(value as string | null | undefined);
    output[key] = value as string | null | undefined;
  }
  return output;
}

export type PublicationQueueCandidateQuery = {
  executablePlatforms: readonly PublicationPlatform[];
  includeQueued?: boolean;
  includeDueRetryWait?: boolean;
  reconcilablePlatforms?: readonly PublicationPlatform[];
  limit?: number;
  now?: Date;
};

function assertRemoteIdentity(
  platform: PublicationPlatform,
  remoteOwnerId: string | null | undefined,
  remoteMediaId: string,
  remoteUrl?: string | null,
) {
  if (!remoteMediaId.trim()) throw new Error('Remote media identity is required');
  if (platform === 'youtube' && remoteOwnerId) {
    throw new Error('YouTube remote owner identity must be absent');
  }
  if (platform === 'vk' && !remoteOwnerId?.trim()) {
    throw new Error('VK remote owner identity is required');
  }
  assertCanonicalRemoteUrl(remoteUrl);
}

export function createPublicationRepository(db: Database) {
  return {
    createOwnedPublication: async (userId: string, input: CreatePublicationInput) => {
      return db.transaction(async (tx) => {
        const [ownedVideo, ownedAccount] = await Promise.all([
          tx
            .select()
            .from(video)
            .where(
              and(eq(video.id, input.videoId), eq(video.userId, userId), eq(video.state, 'ready')),
            )
            .limit(1),
          tx
            .select()
            .from(publishingAccount)
            .where(
              and(
                eq(publishingAccount.id, input.publishingAccountId),
                eq(publishingAccount.userId, userId),
                eq(publishingAccount.platform, input.platform),
              ),
            )
            .limit(1),
        ]);
        if (!ownedVideo[0]) throw new Error('Video is not owned or ready');
        if (!ownedAccount[0])
          throw new Error('Publishing account is not owned or platform-matched');
        return tx
          .insert(publication)
          .values({ userId, ...input, metadata: input.metadata ?? {} })
          .returning();
      });
    },

    findByIdForUser: (userId: string, id: string) =>
      db
        .select()
        .from(publication)
        .where(and(eq(publication.id, id), eq(publication.userId, userId)))
        .limit(1),

    retryFailedPublication: (userId: string, id: string, expectedRevision: number) =>
      db
        .update(publication)
        .set({
          state: 'queued',
          retryCycleAttemptCount: 0,
          retryCycleStartedAt: new Date(),
          nextAttemptAt: null,
          reconciliationRequiredAt: null,
          failureClass: null,
          failureCode: null,
          failureMessage: null,
          leaseToken: null,
          leaseExpiresAt: null,
          revision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publication.id, id),
            eq(publication.userId, userId),
            eq(publication.state, 'failed'),
            eq(publication.revision, expectedRevision),
            isNull(publication.remoteMediaId),
          ),
        )
        .returning(),

    findById: (id: string) => db.select().from(publication).where(eq(publication.id, id)).limit(1),

    listQueueCandidates: (input: PublicationQueueCandidateQuery) => {
      const now = input.now ?? new Date();
      const predicates = [];
      if (input.includeQueued !== false && input.executablePlatforms.length > 0)
        predicates.push(
          and(
            eq(publication.state, 'queued'),
            inArray(publication.platform, input.executablePlatforms),
          ),
        );
      if (input.includeDueRetryWait !== false && input.executablePlatforms.length > 0)
        predicates.push(
          and(
            eq(publication.state, 'retry_wait'),
            lte(publication.nextAttemptAt, now),
            inArray(publication.platform, input.executablePlatforms),
          ),
        );
      if (input.reconcilablePlatforms && input.reconcilablePlatforms.length > 0)
        predicates.push(
          and(
            eq(publication.state, 'reconciling'),
            lte(publication.reconciliationRequiredAt, now),
            inArray(publication.platform, input.reconcilablePlatforms),
          ),
        );
      return db
        .select()
        .from(publication)
        .where(predicates.length > 0 ? or(...predicates) : sql`false`)
        .orderBy(asc(publication.nextAttemptAt), asc(publication.createdAt), asc(publication.id))
        .limit(input.limit ?? 100);
    },

    listExpiredPublicationLeases: (limit = 100, now = new Date()) =>
      db
        .select()
        .from(publication)
        .where(
          and(
            inArray(publication.state, ['publishing', 'reconciling']),
            lte(publication.leaseExpiresAt, now),
          ),
        )
        .orderBy(asc(publication.leaseExpiresAt), asc(publication.updatedAt))
        .limit(limit),

    renewPublicationLease: (
      userId: string,
      publicationId: string,
      expectedRevision: number,
      leaseToken: string,
      leaseDurationMs: number,
      expectedState: 'publishing' | 'reconciling' = 'publishing',
    ) => {
      const now = new Date();
      return db
        .update(publication)
        .set({ leaseExpiresAt: new Date(now.getTime() + leaseDurationMs), updatedAt: now })
        .where(
          and(
            eq(publication.id, publicationId),
            eq(publication.userId, userId),
            eq(publication.state, expectedState),
            eq(publication.revision, expectedRevision),
            eq(publication.leaseToken, leaseToken),
          ),
        )
        .returning();
    },

    recoverExpiredPublicationLease: async (input: ExpiredPublicationLeaseInput) =>
      db.transaction(async (tx) => {
        const lockedPublication = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, input.publicationId),
              inArray(publication.state, ['publishing', 'reconciling']),
              eq(publication.revision, input.expectedPublicationRevision),
              eq(publication.leaseToken, input.expectedLeaseToken),
              lte(publication.leaseExpiresAt, new Date()),
            ),
          )
          .for('update');
        const current = lockedPublication[0];
        if (!current) return { outcome: 'stale' as const };
        const attempts = await tx
          .select()
          .from(publicationAttempt)
          .where(
            and(
              eq(publicationAttempt.publicationId, current.id),
              eq(publicationAttempt.userId, current.userId),
              eq(publicationAttempt.id, input.expectedAttemptId),
              eq(publicationAttempt.revision, input.expectedAttemptRevision),
              eq(publicationAttempt.state, input.expectedAttemptState),
            ),
          )
          .orderBy(desc(publicationAttempt.attemptNumber))
          .limit(1)
          .for('update');
        if (!attempts[0]) return { outcome: 'stale' as const };

        if (current.state === 'reconciling') {
          const publicationRow = await tx
            .update(publication)
            .set({
              reconciliationRequiredAt: input.retryAt,
              leaseToken: null,
              leaseExpiresAt: null,
              revision: input.expectedPublicationRevision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(publication.id, current.id),
                eq(publication.state, 'reconciling'),
                eq(publication.revision, input.expectedPublicationRevision),
                eq(publication.leaseToken, input.expectedLeaseToken),
              ),
            )
            .returning();
          if (publicationRow.length === 0) return { outcome: 'stale' as const };
          return { outcome: 'reconciling' as const, publication: publicationRow[0]! };
        }

        if (input.expectedAttemptState === 'started') {
          const attempt = await tx
            .update(publicationAttempt)
            .set({
              state: 'definitely_failed',
              failureClass: 'worker',
              failureCode: 'LEASE_EXPIRED_BEFORE_REQUEST',
              failureMessage: 'Worker lease expired before provider request intent',
              finishedAt: new Date(),
              revision: input.expectedAttemptRevision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(publicationAttempt.id, input.expectedAttemptId),
                eq(publicationAttempt.userId, current.userId),
                eq(publicationAttempt.state, 'started'),
                eq(publicationAttempt.revision, input.expectedAttemptRevision),
              ),
            )
            .returning();
          const publicationRow = await tx
            .update(publication)
            .set({
              state: 'retry_wait',
              nextAttemptAt: input.retryAt,
              failureClass: 'worker',
              failureCode: 'LEASE_EXPIRED_BEFORE_REQUEST',
              failureMessage: 'Worker lease expired before provider request intent',
              leaseToken: null,
              leaseExpiresAt: null,
              revision: input.expectedPublicationRevision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(publication.id, current.id),
                eq(publication.state, 'publishing'),
                eq(publication.revision, input.expectedPublicationRevision),
                eq(publication.leaseToken, input.expectedLeaseToken),
              ),
            )
            .returning();
          if (attempt.length === 0 || publicationRow.length === 0)
            return { outcome: 'stale' as const };
          return { outcome: 'retry_wait' as const, publication: publicationRow[0]! };
        }

        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'ambiguous',
            revision: input.expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, input.expectedAttemptId),
              eq(publicationAttempt.userId, current.userId),
              eq(publicationAttempt.state, 'request_sent'),
              eq(publicationAttempt.revision, input.expectedAttemptRevision),
            ),
          )
          .returning();
        const publicationRow = await tx
          .update(publication)
          .set({
            state: 'reconciling',
            reconciliationRequiredAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            revision: input.expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, current.id),
              eq(publication.state, 'publishing'),
              eq(publication.revision, input.expectedPublicationRevision),
              eq(publication.leaseToken, input.expectedLeaseToken),
            ),
          )
          .returning();
        if (attempt.length === 0 || publicationRow.length === 0)
          return { outcome: 'stale' as const };
        return { outcome: 'reconciling' as const, publication: publicationRow[0]! };
      }),

    listForUser: (userId: string) =>
      db.select().from(publication).where(eq(publication.userId, userId)),

    claimPublication: async (
      userId: string,
      id: string,
      expectedState: 'queued' | 'retry_wait',
      expectedRevision: number,
      leaseDurationMs: number,
    ) => {
      const now = new Date();
      const leaseToken = randomUUID();
      return db.transaction(async (tx) => {
        const claimed = await tx
          .update(publication)
          .set({
            state: 'publishing',
            attemptCount: sql`${publication.attemptCount} + 1`,
            retryCycleAttemptCount: sql`${publication.retryCycleAttemptCount} + 1`,
            lastAttemptAt: now,
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
            nextAttemptAt: null,
            revision: expectedRevision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(publication.id, id),
              eq(publication.userId, userId),
              eq(publication.state, expectedState),
              eq(publication.revision, expectedRevision),
              or(isNull(publication.nextAttemptAt), lte(publication.nextAttemptAt, now)),
            ),
          )
          .returning();
        if (claimed.length === 0) throw new Error('Publication claim was stale or not due');
        const current = claimed[0]!;
        const attempt = await tx
          .insert(publicationAttempt)
          .values({
            publicationId: current.id,
            userId,
            attemptNumber: current.attemptCount,
            state: 'started',
          })
          .returning();
        return { publication: current, attempt: attempt[0]! };
      });
    },

    claimReconciliation: async (
      userId: string,
      id: string,
      expectedRevision: number,
      leaseDurationMs: number,
      now = new Date(),
    ) => {
      const leaseToken = randomUUID();
      return db.transaction(async (tx) => {
        const claimed = await tx
          .update(publication)
          .set({
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
            revision: expectedRevision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(publication.id, id),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedRevision),
              lte(publication.reconciliationRequiredAt, now),
              isNull(publication.leaseToken),
            ),
          )
          .returning();
        if (!claimed[0]) return null;
        const attempts = await tx
          .select()
          .from(publicationAttempt)
          .where(
            and(
              eq(publicationAttempt.publicationId, id),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
            ),
          )
          .orderBy(desc(publicationAttempt.attemptNumber))
          .limit(1);
        if (!attempts[0]) throw new Error('Reconcilable publication has no ambiguous attempt');
        return { publication: claimed[0], attempt: attempts[0] };
      });
    },

    listAttemptsForUser: (userId: string, publicationId: string) =>
      db
        .select()
        .from(publicationAttempt)
        .where(
          and(
            eq(publicationAttempt.userId, userId),
            eq(publicationAttempt.publicationId, publicationId),
          ),
        ),

    findLatestAttemptForUser: (userId: string, publicationId: string) =>
      db
        .select()
        .from(publicationAttempt)
        .where(
          and(
            eq(publicationAttempt.userId, userId),
            eq(publicationAttempt.publicationId, publicationId),
          ),
        )
        .orderBy(desc(publicationAttempt.attemptNumber))
        .limit(1),

    markAttemptRequestSent: async (
      userId: string,
      attemptId: string,
      expectedRevision: number,
      ownership: PublicationRequestOwnership,
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(eq(publication.id, ownership.publicationId))
          .limit(1)
          .for('update');
        if (!parent[0]) return [];
        if (
          parent[0].userId !== userId ||
          parent[0].state !== 'publishing' ||
          parent[0].revision !== ownership.expectedPublicationRevision ||
          parent[0].leaseToken !== ownership.expectedLeaseToken ||
          ownership.credential.accountId !== parent[0].publishingAccountId ||
          ownership.credential.userId !== userId ||
          ownership.credential.platform !== parent[0].platform
        )
          return [];
        const account = await tx
          .select()
          .from(publishingAccount)
          .where(eq(publishingAccount.id, parent[0].publishingAccountId))
          .limit(1)
          .for('update');
        if (!account[0]) return [];
        if (
          account[0].id !== ownership.credential.accountId ||
          account[0].userId !== ownership.credential.userId ||
          account[0].platform !== ownership.credential.platform ||
          account[0].status !== 'active' ||
          account[0].credentialRevision !== ownership.credential.credentialRevision
        )
          return [];
        const attempt = await tx
          .select()
          .from(publicationAttempt)
          .where(eq(publicationAttempt.id, attemptId))
          .limit(1)
          .for('update');
        if (!attempt[0]) return [];
        if (
          attempt[0].id !== attemptId ||
          attempt[0].publicationId !== ownership.publicationId ||
          attempt[0].userId !== userId ||
          attempt[0].state !== 'started' ||
          attempt[0].revision !== expectedRevision
        )
          return [];
        return tx
          .update(publicationAttempt)
          .set({
            state: 'request_sent',
            requestSentAt: new Date(),
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'started'),
              eq(publicationAttempt.revision, expectedRevision),
              eq(publicationAttempt.publicationId, ownership.publicationId),
            ),
          )
          .returning();
      }),

    checkpointAttemptEvidence: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      ownership: PublicationEvidenceOwnership,
      evidence: unknown,
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, ownership.expectedPublicationState),
              eq(publication.revision, ownership.expectedPublicationRevision),
              eq(publication.leaseToken, ownership.expectedLeaseToken),
            ),
          )
          .for('update');
        if (!parent[0]) return { outcome: 'stale' as const };
        const attempts = await tx
          .select()
          .from(publicationAttempt)
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, ownership.expectedAttemptState),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .for('update');
        const current = attempts[0];
        if (!current) return { outcome: 'stale' as const };
        const incoming = normalizedEvidence(evidence);
        const updates: AttemptEvidenceInput = {};
        for (const key of [
          'providerRequestId',
          'remoteOwnerId',
          'remoteMediaId',
          'remoteUrl',
        ] as const) {
          const oldValue = current[key];
          const newValue = incoming[key];
          if (newValue === undefined) continue;
          if (oldValue !== null && oldValue !== newValue) return { outcome: 'conflict' as const };
          if (oldValue === null && newValue !== null) updates[key] = newValue;
        }
        if (Object.keys(updates).length === 0)
          return { outcome: 'unchanged' as const, attempt: current };
        const updated = await tx
          .update(publicationAttempt)
          .set({ ...updates, revision: expectedAttemptRevision + 1, updatedAt: new Date() })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, ownership.expectedAttemptState),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        return updated[0]
          ? { outcome: 'updated' as const, attempt: updated[0] }
          : { outcome: 'stale' as const };
      }),

    markAmbiguous: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Publication ambiguity claim was stale');
        const attempt = await tx
          .update(publicationAttempt)
          .set({ state: 'ambiguous', revision: expectedAttemptRevision + 1, updatedAt: new Date() })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'request_sent'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Attempt ambiguity claim was stale');
        const updatedPublication = await tx
          .update(publication)
          .set({
            state: 'reconciling',
            reconciliationRequiredAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (updatedPublication.length === 0)
          throw new Error('Publication ambiguity claim was stale');
        return { attempt: attempt[0]!, publication: updatedPublication[0]! };
      }),

    reconcileAbsent: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      nextAttemptAt: Date,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Publication reconciliation was stale');
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'reconciled_absent',
            reconciliationCheckedAt: new Date(),
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Reconciliation was stale');
        const updatedPublication = await tx
          .update(publication)
          .set({
            state: 'retry_wait',
            nextAttemptAt,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (updatedPublication.length === 0)
          throw new Error('Publication reconciliation was stale');
        return { attempt: attempt[0]!, publication: updatedPublication[0]! };
      }),

    reconcileSucceeded: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      remoteOwnerId: string | null | undefined,
      remoteMediaId: string,
      remoteUrl?: string | null,
      ownership?: { expectedLeaseToken: string },
    ) => {
      return db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Publication reconciliation was stale');
        assertRemoteIdentity(
          parent[0]!.platform as PublicationPlatform,
          remoteOwnerId,
          remoteMediaId,
          remoteUrl,
        );
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'reconciled_succeeded',
            remoteOwnerId: remoteOwnerId ?? null,
            remoteMediaId,
            remoteUrl: remoteUrl ?? null,
            reconciliationCheckedAt: new Date(),
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Reconciliation was stale');
        const updatedPublication = await tx
          .update(publication)
          .set({
            state: 'published',
            remoteOwnerId: remoteOwnerId ?? null,
            remoteMediaId,
            remoteUrl: remoteUrl ?? null,
            publishedAt: new Date(),
            reconciliationRequiredAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (updatedPublication.length === 0)
          throw new Error('Publication reconciliation was stale');
        return { attempt: attempt[0]!, publication: updatedPublication[0]! };
      });
    },

    reconcileUnresolved: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      nextCheckAt: Date,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (!parent[0]) throw new Error('Publication reconciliation was stale');
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            reconciliationCheckedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (!attempt[0]) throw new Error('Reconciliation attempt was stale');
        const updatedPublication = await tx
          .update(publication)
          .set({
            reconciliationRequiredAt: nextCheckAt,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (!updatedPublication[0]) throw new Error('Publication reconciliation was stale');
        return { attempt: attempt[0], publication: updatedPublication[0] };
      }),

    reconcileTerminalFailure: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      failureCode: string,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (!parent[0]) throw new Error('Publication reconciliation was stale');
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'definitely_failed',
            failureClass: 'reconciliation',
            failureCode,
            finishedAt: new Date(),
            reconciliationCheckedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (!attempt[0]) throw new Error('Reconciliation attempt was stale');
        const settled = await tx
          .update(publication)
          .set({
            state: 'failed',
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            failureClass: 'reconciliation',
            failureCode,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (!settled[0]) throw new Error('Publication reconciliation was stale');
        return { attempt: attempt[0], publication: settled[0] };
      }),

    cancelQueuedPublication: (
      userId: string,
      publicationId: string,
      expectedState: 'queued' | 'retry_wait',
      expectedRevision: number,
    ) =>
      db
        .update(publication)
        .set({
          state: 'cancelled',
          nextAttemptAt: null,
          updatedAt: new Date(),
          revision: expectedRevision + 1,
        })
        .where(
          and(
            eq(publication.id, publicationId),
            eq(publication.userId, userId),
            eq(publication.state, expectedState),
            eq(publication.revision, expectedRevision),
          ),
        )
        .returning(),

    cancelStartedPublication: async (
      userId: string,
      publicationId: string,
      expectedPublicationRevision: number,
      expectedLeaseToken: string,
      attemptId: string,
      expectedAttemptRevision: number,
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              eq(publication.leaseToken, expectedLeaseToken),
            ),
          )
          .for('update');
        if (!parent[0]) return [];
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'definitely_failed',
            failureClass: 'cancelled',
            failureCode: 'CANCELLED_BEFORE_REQUEST',
            failureMessage: 'Publication cancelled before provider request intent',
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'started'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (!attempt[0]) return [];
        return tx
          .update(publication)
          .set({
            state: 'cancelled',
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              eq(publication.leaseToken, expectedLeaseToken),
            ),
          )
          .returning();
      }),

    settleDefinitiveSuccess: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      remoteOwnerId: string | null | undefined,
      remoteMediaId: string,
      remoteUrl?: string | null,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Publication settlement was stale');
        assertRemoteIdentity(
          parent[0]!.platform as PublicationPlatform,
          remoteOwnerId,
          remoteMediaId,
          remoteUrl,
        );
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'succeeded',
            remoteOwnerId: remoteOwnerId ?? null,
            remoteMediaId,
            remoteUrl: remoteUrl ?? null,
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'request_sent'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Publication attempt settlement was stale');
        const published = await tx
          .update(publication)
          .set({
            state: 'published',
            remoteOwnerId: remoteOwnerId ?? null,
            remoteMediaId,
            remoteUrl: remoteUrl ?? null,
            publishedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (published.length === 0) throw new Error('Publication settlement was stale');
        return { attempt: attempt[0]!, publication: published[0]! };
      }),

    settleDefinitiveFailure: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      expectedAttemptState: 'started' | 'request_sent',
      input: DefinitiveFailureInput,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Publication failure settlement was stale');
        if (input.retryable && !input.nextAttemptAt)
          throw new Error('Retryable failure requires next attempt time');
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'definitely_failed',
            failureClass: input.failureClass,
            failureCode: input.failureCode,
            failureMessage: input.failureMessage ?? null,
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, expectedAttemptState),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Publication failure attempt was stale');
        const settled = await tx
          .update(publication)
          .set({
            state: input.retryable ? 'retry_wait' : 'failed',
            nextAttemptAt: input.retryable ? input.nextAttemptAt! : null,
            failureClass: input.failureClass,
            failureCode: input.failureCode,
            failureMessage: input.failureMessage ?? null,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'publishing'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (settled.length === 0) throw new Error('Publication failure settlement was stale');
        return { attempt: attempt[0]!, publication: settled[0]! };
      }),

    markManualReview: async (
      userId: string,
      publicationId: string,
      attemptId: string,
      expectedAttemptRevision: number,
      expectedPublicationRevision: number,
      ownership?: { expectedLeaseToken: string },
    ) =>
      db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(publication)
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .for('update');
        if (parent.length === 0) throw new Error('Manual review settlement was stale');
        const attempt = await tx
          .update(publicationAttempt)
          .set({
            state: 'manual_review',
            reconciliationCheckedAt: new Date(),
            finishedAt: new Date(),
            revision: expectedAttemptRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publicationAttempt.id, attemptId),
              eq(publicationAttempt.publicationId, publicationId),
              eq(publicationAttempt.userId, userId),
              eq(publicationAttempt.state, 'ambiguous'),
              eq(publicationAttempt.revision, expectedAttemptRevision),
            ),
          )
          .returning();
        if (attempt.length === 0) throw new Error('Manual review attempt was stale');
        const settled = await tx
          .update(publication)
          .set({
            state: 'manual_review',
            leaseToken: null,
            leaseExpiresAt: null,
            revision: expectedPublicationRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(publication.id, publicationId),
              eq(publication.userId, userId),
              eq(publication.state, 'reconciling'),
              eq(publication.revision, expectedPublicationRevision),
              ...(ownership ? [eq(publication.leaseToken, ownership.expectedLeaseToken)] : []),
            ),
          )
          .returning();
        if (settled.length === 0) throw new Error('Manual review settlement was stale');
        return { attempt: attempt[0]!, publication: settled[0]! };
      }),
  };
}
