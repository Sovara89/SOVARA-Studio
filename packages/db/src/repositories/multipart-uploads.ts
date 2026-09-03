import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { multipartUpload, uploadPart } from '../schema/multipart-uploads.js';
import { video } from '../schema/videos.js';

type Database = ReturnType<typeof createDatabase>['db'];

export type CreateMultipartUploadInput = {
  videoId: string;
  providerUploadId: string | null;
  partSizeBytes: number;
  expectedPartCount: number;
  expiresAt: Date;
  state?: 'initiating' | 'initiation_reconciling' | 'active';
};

export type RecordUploadPartInput = {
  partNumber: number;
  etag: string;
  reportedSizeBytes?: number | null;
  providerChecksumAlgorithm?: string | null;
  providerChecksumValue?: string | null;
};

export type CompletionPartInput = {
  partNumber: number;
  etag: string;
};

export type MultipartFailureInput = {
  failureCode: string;
  failureMessage?: string | null;
};

function assertPartNumber(partNumber: number) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
    throw new Error('Part number must be between 1 and 10000');
}

export function createMultipartUploadRepository(db: Database) {
  const settleProviderCompletion = async (
    userId: string,
    multipartUploadId: string,
    expectedUploadState: 'completing' | 'abort_pending',
    expectedUploadRevision: number,
    expectedVideoRevision: number,
    evidence: {
      objectEtag?: string | null;
      objectVersionId?: string | null;
      checksumAlgorithm?: string | null;
      checksumValue?: string | null;
    } = {},
  ) =>
    db.transaction(async (tx) => {
      const lockedUpload = await tx
        .select()
        .from(multipartUpload)
        .where(and(eq(multipartUpload.id, multipartUploadId), eq(multipartUpload.userId, userId)))
        .for('update');
      const currentUpload = lockedUpload[0];
      if (
        !currentUpload ||
        currentUpload.state !== expectedUploadState ||
        currentUpload.revision !== expectedUploadRevision
      )
        throw new Error('Multipart completion settlement is stale');
      const lockedVideo = await tx
        .select()
        .from(video)
        .where(and(eq(video.id, currentUpload.videoId), eq(video.userId, userId)))
        .for('update');
      const currentVideo = lockedVideo[0];
      if (
        !currentVideo ||
        currentVideo.state !== 'uploading' ||
        currentVideo.revision !== expectedVideoRevision
      )
        throw new Error('Video completion settlement is stale');
      const completed = await tx
        .update(multipartUpload)
        .set({
          state: 'completed',
          completedAt: new Date(),
          revision: expectedUploadRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, multipartUploadId),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, expectedUploadState),
            eq(multipartUpload.revision, expectedUploadRevision),
          ),
        )
        .returning();
      const uploaded = await tx
        .update(video)
        .set({
          state: 'uploaded',
          objectEtag: evidence.objectEtag ?? null,
          objectVersionId: evidence.objectVersionId ?? null,
          verifiedChecksumAlgorithm: evidence.checksumAlgorithm ?? null,
          verifiedChecksumValue: evidence.checksumValue ?? null,
          revision: expectedVideoRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(video.id, currentVideo.id),
            eq(video.userId, userId),
            eq(video.state, 'uploading'),
            eq(video.revision, expectedVideoRevision),
          ),
        )
        .returning();
      if (completed.length === 0 || uploaded.length === 0)
        throw new Error('Multipart completion settlement was stale');
      return { upload: completed[0]!, video: uploaded[0]! };
    });

  return {
    createOwnedUpload: async (userId: string, input: CreateMultipartUploadInput) =>
      db.transaction(async (tx) => {
        const ownedVideo = await tx
          .select()
          .from(video)
          .where(and(eq(video.id, input.videoId), eq(video.userId, userId)))
          .for('update');
        const currentVideo = ownedVideo[0];
        if (!currentVideo || !['awaiting_upload', 'uploading'].includes(currentVideo.state))
          throw new Error('Video is not available for multipart upload');
        if (currentVideo.state === 'awaiting_upload') {
          const uploading = await tx
            .update(video)
            .set({ state: 'uploading', revision: currentVideo.revision + 1, updatedAt: new Date() })
            .where(
              and(
                eq(video.id, input.videoId),
                eq(video.userId, userId),
                eq(video.state, 'awaiting_upload'),
                eq(video.revision, currentVideo.revision),
              ),
            )
            .returning();
          if (uploading.length === 0) throw new Error('Video upload transition was stale');
        }
        return tx
          .insert(multipartUpload)
          .values({
            userId,
            ...input,
            state: input.state ?? (input.providerUploadId ? 'active' : 'initiating'),
          })
          .returning();
      }),

    associateProviderUpload: (
      userId: string,
      id: string,
      expectedRevision: number,
      providerUploadId: string,
    ) =>
      db
        .update(multipartUpload)
        .set({
          providerUploadId,
          state: 'active',
          revision: sql`${multipartUpload.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, 'initiating'),
            eq(multipartUpload.revision, expectedRevision),
            sql`${multipartUpload.providerUploadId} IS NULL`,
          ),
        )
        .returning(),

    findByIdForUser: (userId: string, id: string) =>
      db
        .select()
        .from(multipartUpload)
        .where(and(eq(multipartUpload.id, id), eq(multipartUpload.userId, userId)))
        .limit(1),

    findForVideoForUser: (userId: string, videoId: string) =>
      db
        .select()
        .from(multipartUpload)
        .where(and(eq(multipartUpload.userId, userId), eq(multipartUpload.videoId, videoId)))
        .orderBy(asc(multipartUpload.createdAt)),

    findUnresolvedForVideoForUser: (userId: string, videoId: string) =>
      db
        .select()
        .from(multipartUpload)
        .where(
          and(
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.videoId, videoId),
            sql`${multipartUpload.state} IN ('initiating', 'initiation_reconciling', 'active', 'completing', 'abort_pending', 'failed')`,
          ),
        )
        .limit(1),

    listCleanupCandidates: (input: { now: Date; abortPendingBefore: Date; limit: number }) =>
      db
        .select({ upload: multipartUpload })
        .from(multipartUpload)
        .where(
          or(
            and(
              inArray(multipartUpload.state, ['active', 'completing', 'failed']),
              lte(multipartUpload.expiresAt, input.now),
            ),
            and(
              eq(multipartUpload.state, 'abort_pending'),
              lte(multipartUpload.updatedAt, input.abortPendingBefore),
            ),
          ),
        )
        .orderBy(asc(multipartUpload.expiresAt), asc(multipartUpload.updatedAt))
        .limit(input.limit),

    claimCleanupCandidate: (
      userId: string,
      id: string,
      expectedState: 'active' | 'completing' | 'abort_pending' | 'failed',
      expectedRevision: number,
      now: Date,
      abortPendingBefore: Date,
    ) =>
      db
        .update(multipartUpload)
        .set({ state: 'abort_pending', revision: expectedRevision + 1, updatedAt: now })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, expectedState),
            eq(multipartUpload.revision, expectedRevision),
            ...(expectedState === 'abort_pending'
              ? [lte(multipartUpload.updatedAt, abortPendingBefore)]
              : [lte(multipartUpload.expiresAt, now)]),
          ),
        )
        .returning(),

    listInitiationReconciliationRequired: (limit = 100, updatedBefore = new Date()) =>
      db
        .select()
        .from(multipartUpload)
        .where(
          and(
            sql`${multipartUpload.state} IN ('initiating', 'initiation_reconciling')`,
            lte(multipartUpload.updatedAt, updatedBefore),
          ),
        )
        .orderBy(asc(multipartUpload.createdAt))
        .limit(limit),

    claimInitiationReconciliation: (userId: string, id: string, expectedRevision: number) =>
      db
        .update(multipartUpload)
        .set({
          state: 'initiation_reconciling',
          revision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, 'initiating'),
            eq(multipartUpload.revision, expectedRevision),
            sql`${multipartUpload.providerUploadId} IS NULL`,
          ),
        )
        .returning(),

    listPartsForUser: (userId: string, multipartUploadId: string) =>
      db
        .select()
        .from(uploadPart)
        .where(
          and(eq(uploadPart.userId, userId), eq(uploadPart.multipartUploadId, multipartUploadId)),
        )
        .orderBy(asc(uploadPart.partNumber)),

    recordOrReplacePart: async (
      userId: string,
      multipartUploadId: string,
      input: RecordUploadPartInput,
    ) => {
      assertPartNumber(input.partNumber);
      return db.transaction(async (tx) => {
        const ownedUpload = await tx
          .select()
          .from(multipartUpload)
          .where(and(eq(multipartUpload.id, multipartUploadId), eq(multipartUpload.userId, userId)))
          .for('update');
        const current = ownedUpload[0];
        if (!current || current.state !== 'active')
          throw new Error('Multipart upload is not active');
        if (input.partNumber > current.expectedPartCount)
          throw new Error('Part number exceeds expected part count');
        const values = { ...input, userId, multipartUploadId };
        const updated = await tx
          .update(uploadPart)
          .set({ ...values, revision: sql`${uploadPart.revision} + 1`, updatedAt: new Date() })
          .where(
            and(
              eq(uploadPart.multipartUploadId, multipartUploadId),
              eq(uploadPart.userId, userId),
              eq(uploadPart.partNumber, input.partNumber),
            ),
          )
          .returning();
        if (updated.length > 0) return updated;
        return tx.insert(uploadPart).values(values).returning();
      });
    },

    claimCompletion: async (
      userId: string,
      multipartUploadId: string,
      expectedRevision: number,
      requestedParts: readonly CompletionPartInput[],
    ) =>
      db.transaction(async (tx) => {
        const ownedUpload = await tx
          .select()
          .from(multipartUpload)
          .where(and(eq(multipartUpload.id, multipartUploadId), eq(multipartUpload.userId, userId)))
          .for('update');
        const current = ownedUpload[0];
        if (!current) throw new Error('Multipart upload not found');
        if (current.state !== 'active' || current.revision !== expectedRevision)
          throw new Error('Multipart upload is stale or not active');
        if (current.expiresAt.getTime() <= Date.now())
          throw new Error('Multipart upload has expired');
        const ownedVideo = await tx
          .select()
          .from(video)
          .where(and(eq(video.id, current.videoId), eq(video.userId, userId)))
          .for('update');
        const currentVideo = ownedVideo[0];
        if (!currentVideo || currentVideo.state !== 'uploading')
          throw new Error('Video is not available for completion');
        if (requestedParts.length !== current.expectedPartCount)
          throw new Error('Completion part set is incomplete');
        const numbers = requestedParts.map((part) => part.partNumber);
        if (
          new Set(numbers).size !== numbers.length ||
          numbers.some((partNumber, index) => partNumber !== index + 1)
        )
          throw new Error('Completion part set must be contiguous and ordered');
        const persisted = await tx
          .select()
          .from(uploadPart)
          .where(
            and(
              eq(uploadPart.multipartUploadId, multipartUploadId),
              eq(uploadPart.userId, userId),
              inArray(uploadPart.partNumber, numbers),
            ),
          )
          .orderBy(asc(uploadPart.partNumber));
        if (
          persisted.length !== requestedParts.length ||
          persisted.some((part, index) => {
            const expectedSize =
              part.partNumber < current.expectedPartCount
                ? current.partSizeBytes
                : currentVideo.expectedSizeBytes -
                  current.partSizeBytes * (current.expectedPartCount - 1);
            return (
              part.etag !== requestedParts[index]?.etag || part.reportedSizeBytes !== expectedSize
            );
          })
        )
          throw new Error('Completion parts do not match persisted upload parts');
        const completing = await tx
          .update(multipartUpload)
          .set({
            state: 'completing',
            completionRequestedAt: new Date(),
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(multipartUpload.id, multipartUploadId),
              eq(multipartUpload.userId, userId),
              eq(multipartUpload.state, 'active'),
              eq(multipartUpload.revision, expectedRevision),
            ),
          )
          .returning();
        if (completing.length === 0) throw new Error('Multipart completion claim was stale');
        return { upload: completing[0]!, video: currentVideo, parts: persisted };
      }),

    settleCompletion: (
      userId: string,
      multipartUploadId: string,
      expectedUploadRevision: number,
      expectedVideoRevision: number,
      evidence: {
        objectEtag?: string | null;
        objectVersionId?: string | null;
        checksumAlgorithm?: string | null;
        checksumValue?: string | null;
      } = {},
    ) =>
      settleProviderCompletion(
        userId,
        multipartUploadId,
        'completing',
        expectedUploadRevision,
        expectedVideoRevision,
        evidence,
      ),

    settleAbortPendingCompletion: (
      userId: string,
      multipartUploadId: string,
      expectedUploadRevision: number,
      expectedVideoRevision: number,
      evidence: {
        objectEtag?: string | null;
        objectVersionId?: string | null;
        checksumAlgorithm?: string | null;
        checksumValue?: string | null;
      } = {},
    ) =>
      settleProviderCompletion(
        userId,
        multipartUploadId,
        'abort_pending',
        expectedUploadRevision,
        expectedVideoRevision,
        evidence,
      ),

    markCompletionPending: (
      userId: string,
      id: string,
      expectedRevision: number,
      input: MultipartFailureInput,
    ) =>
      db
        .update(multipartUpload)
        .set({
          failureCode: input.failureCode,
          failureMessage: input.failureMessage ?? null,
          revision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, 'completing'),
            eq(multipartUpload.revision, expectedRevision),
          ),
        )
        .returning(),

    failCompletion: async (
      userId: string,
      id: string,
      expectedUploadRevision: number,
      input: MultipartFailureInput,
    ) =>
      db.transaction(async (tx) => {
        const lockedUpload = await tx
          .select()
          .from(multipartUpload)
          .where(and(eq(multipartUpload.id, id), eq(multipartUpload.userId, userId)))
          .for('update');
        const currentUpload = lockedUpload[0];
        if (
          !currentUpload ||
          currentUpload.state !== 'completing' ||
          currentUpload.revision !== expectedUploadRevision
        )
          return [];
        const failedUpload = await tx
          .update(multipartUpload)
          .set({
            state: 'failed',
            failureCode: input.failureCode,
            failureMessage: input.failureMessage ?? null,
            revision: expectedUploadRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(multipartUpload.id, id),
              eq(multipartUpload.userId, userId),
              eq(multipartUpload.state, 'completing'),
              eq(multipartUpload.revision, expectedUploadRevision),
            ),
          )
          .returning();
        const failedVideo = await tx
          .update(video)
          .set({
            state: 'failed',
            failureCode: input.failureCode,
            failureMessage: input.failureMessage ?? null,
            revision: sql`${video.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(video.id, currentUpload.videoId),
              eq(video.userId, userId),
              eq(video.state, 'uploading'),
            ),
          )
          .returning();
        return failedUpload.length > 0 && failedVideo.length > 0 ? failedUpload : [];
      }),

    requestAbort: async (
      userId: string,
      id: string,
      expectedState: 'active' | 'completing' | 'failed',
      expectedRevision: number,
    ) =>
      db
        .update(multipartUpload)
        .set({ state: 'abort_pending', revision: expectedRevision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, expectedState),
            eq(multipartUpload.revision, expectedRevision),
          ),
        )
        .returning(),

    settleAbort: (
      userId: string,
      id: string,
      expectedRevision: number,
      finalState: 'aborted' | 'expired',
    ) =>
      db
        .update(multipartUpload)
        .set({
          state: finalState,
          closedAt: new Date(),
          revision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, 'abort_pending'),
            eq(multipartUpload.revision, expectedRevision),
          ),
        )
        .returning(),

    settleInitiationFailure: async (userId: string, id: string, failureCode: string) =>
      db.transaction(async (tx) => {
        const ownedUpload = await tx
          .select()
          .from(multipartUpload)
          .where(and(eq(multipartUpload.id, id), eq(multipartUpload.userId, userId)))
          .for('update');
        const currentUpload = ownedUpload[0];
        if (!currentUpload || currentUpload.state !== 'initiating') return ownedUpload;
        const ownedVideo = await tx
          .select()
          .from(video)
          .where(and(eq(video.id, currentUpload.videoId), eq(video.userId, userId)))
          .for('update');
        const currentVideo = ownedVideo[0];
        if (!currentVideo || currentVideo.state !== 'uploading')
          throw new Error('Video initiation settlement is stale');
        const failedVideo = await tx
          .update(video)
          .set({
            state: 'failed',
            failureCode,
            failureMessage: null,
            revision: currentVideo.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(video.id, currentVideo.id),
              eq(video.userId, userId),
              eq(video.state, 'uploading'),
              eq(video.revision, currentVideo.revision),
            ),
          )
          .returning();
        if (failedVideo.length === 0) throw new Error('Video initiation settlement was stale');
        return tx
          .update(multipartUpload)
          .set({
            state: 'aborted',
            failureCode,
            failureMessage: null,
            closedAt: new Date(),
            revision: currentUpload.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(multipartUpload.id, id),
              eq(multipartUpload.userId, userId),
              eq(multipartUpload.state, 'initiating'),
              eq(multipartUpload.revision, currentUpload.revision),
            ),
          )
          .returning();
      }),

    settleInitiationReconciliation: async (
      userId: string,
      id: string,
      expectedUploadRevision: number,
      failureCode: string,
    ) =>
      db.transaction(async (tx) => {
        const ownedUpload = await tx
          .select()
          .from(multipartUpload)
          .where(and(eq(multipartUpload.id, id), eq(multipartUpload.userId, userId)))
          .for('update');
        const currentUpload = ownedUpload[0];
        if (
          !currentUpload ||
          currentUpload.state !== 'initiation_reconciling' ||
          currentUpload.revision !== expectedUploadRevision
        )
          return [];
        const ownedVideo = await tx
          .select()
          .from(video)
          .where(and(eq(video.id, currentUpload.videoId), eq(video.userId, userId)))
          .for('update');
        const currentVideo = ownedVideo[0];
        if (!currentVideo || currentVideo.state !== 'uploading')
          throw new Error('Video initiation reconciliation is stale');
        const failedVideo = await tx
          .update(video)
          .set({
            state: 'failed',
            failureCode,
            failureMessage: null,
            revision: currentVideo.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(video.id, currentVideo.id),
              eq(video.userId, userId),
              eq(video.state, 'uploading'),
              eq(video.revision, currentVideo.revision),
            ),
          )
          .returning();
        if (failedVideo.length === 0) throw new Error('Video initiation reconciliation was stale');
        return tx
          .update(multipartUpload)
          .set({
            state: 'aborted',
            failureCode,
            failureMessage: null,
            closedAt: new Date(),
            revision: expectedUploadRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(multipartUpload.id, id),
              eq(multipartUpload.userId, userId),
              eq(multipartUpload.state, 'initiation_reconciling'),
              eq(multipartUpload.revision, expectedUploadRevision),
            ),
          )
          .returning();
      }),

    markFailed: (
      userId: string,
      id: string,
      expectedState: 'active' | 'completing',
      expectedRevision: number,
      input: MultipartFailureInput,
    ) =>
      db
        .update(multipartUpload)
        .set({
          state: 'failed',
          failureCode: input.failureCode,
          failureMessage: input.failureMessage ?? null,
          revision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(multipartUpload.id, id),
            eq(multipartUpload.userId, userId),
            eq(multipartUpload.state, expectedState),
            eq(multipartUpload.revision, expectedRevision),
          ),
        )
        .returning(),
  };
}
