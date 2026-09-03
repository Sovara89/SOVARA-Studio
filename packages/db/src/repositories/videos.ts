import { and, eq } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { video, type VideoState } from '../schema/videos.js';

type Database = ReturnType<typeof createDatabase>['db'];

export type CreateVideoInput = {
  originalFilename: string;
  contentType: string;
  expectedSizeBytes: number;
  storageBackend: string;
  storageBucket: string;
  objectKey: string;
};

export type VideoVerificationInput = {
  verifiedSizeBytes: number;
  objectVersionId?: string | null;
  objectEtag?: string | null;
  verifiedChecksumAlgorithm?: string | null;
  verifiedChecksumValue?: string | null;
  verifiedAt?: Date;
};

export type VideoFailureInput = {
  verifiedSizeBytes?: number | null;
  verifiedAt?: Date;
  failureCode: string;
  failureMessage?: string | null;
};

function casVideoState(
  db: Database,
  userId: string,
  id: string,
  expectedState: VideoState,
  expectedRevision: number,
  nextState: VideoState,
  values: Record<string, unknown> = {},
) {
  return db
    .update(video)
    .set({ ...values, state: nextState, revision: expectedRevision + 1, updatedAt: new Date() })
    .where(
      and(
        eq(video.id, id),
        eq(video.userId, userId),
        eq(video.state, expectedState),
        eq(video.revision, expectedRevision),
      ),
    )
    .returning();
}

export function createVideoRepository(db: Database) {
  return {
    createOwnedVideo: (userId: string, input: CreateVideoInput) =>
      db
        .insert(video)
        .values({ userId, ...input })
        .returning(),

    findByIdForUser: (userId: string, id: string) =>
      db
        .select()
        .from(video)
        .where(and(eq(video.userId, userId), eq(video.id, id)))
        .limit(1),

    listForUser: (userId: string) => db.select().from(video).where(eq(video.userId, userId)),

    beginUpload: (userId: string, id: string, expectedRevision: number) =>
      casVideoState(db, userId, id, 'awaiting_upload', expectedRevision, 'uploading'),

    beginVerification: (userId: string, id: string, expectedRevision: number) =>
      casVideoState(db, userId, id, 'uploaded', expectedRevision, 'verifying'),

    recordVerified: async (
      userId: string,
      id: string,
      expectedRevision: number,
      input: VideoVerificationInput,
    ) => {
      const current = await db
        .select({ expectedSizeBytes: video.expectedSizeBytes })
        .from(video)
        .where(
          and(
            eq(video.id, id),
            eq(video.userId, userId),
            eq(video.state, 'verifying'),
            eq(video.revision, expectedRevision),
          ),
        )
        .limit(1);
      if (!current[0]) return [];
      if (input.verifiedSizeBytes !== current[0].expectedSizeBytes)
        throw new Error('Verified object size does not match expected size');
      return casVideoState(db, userId, id, 'verifying', expectedRevision, 'ready', {
        ...input,
        verifiedAt: input.verifiedAt ?? new Date(),
        failureCode: null,
        failureMessage: null,
      });
    },

    recordInvalid: (
      userId: string,
      id: string,
      expectedRevision: number,
      input: VideoFailureInput,
    ) =>
      casVideoState(db, userId, id, 'verifying', expectedRevision, 'invalid', {
        ...input,
        verifiedAt: input.verifiedAt ?? new Date(),
      }),

    markFailed: (
      userId: string,
      id: string,
      expectedState: 'awaiting_upload' | 'uploading' | 'uploaded' | 'verifying',
      expectedRevision: number,
      input: VideoFailureInput,
    ) => casVideoState(db, userId, id, expectedState, expectedRevision, 'failed', input),

    requestDeletion: async (
      userId: string,
      id: string,
      expectedState: Exclude<VideoState, 'deleted' | 'deletion_pending'>,
      expectedRevision: number,
    ) =>
      casVideoState(db, userId, id, expectedState, expectedRevision, 'deletion_pending', {
        deletionRequestedAt: new Date(),
      }),

    markDeleted: (userId: string, id: string, expectedRevision: number) =>
      casVideoState(db, userId, id, 'deletion_pending', expectedRevision, 'deleted', {
        deletedAt: new Date(),
      }),
  };
}
