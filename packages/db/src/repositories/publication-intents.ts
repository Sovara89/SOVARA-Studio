import { and, eq } from 'drizzle-orm';
import type { createDatabase } from '../client.js';
import { publishingAccount } from '../schema/publishing-accounts.js';
import { publicationIntent } from '../schema/publication-intents.js';
import { video } from '../schema/videos.js';
type Database = ReturnType<typeof createDatabase>['db'];
export type IntentInput = {
  videoId: string;
  publishingAccountId: string;
  platform: 'youtube' | 'vk';
  mode: 'DRAFT' | 'PUBLISH_NOW' | 'SCHEDULED';
  title: string;
  description?: string | null;
  link: string | null;
  createCommunityPost: boolean;
  scheduledAt?: Date | null;
};
export function createPublicationIntentRepository(db: Database) {
  return {
    create: async (userId: string, input: IntentInput) =>
      db.transaction(async (tx) => {
        const [ownedVideo, account] = await Promise.all([
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
                eq(publishingAccount.status, 'active'),
              ),
            )
            .limit(1),
        ]);
        if (!ownedVideo[0]) throw new Error('VIDEO_NOT_READY');
        if (!account[0]) throw new Error('ACCOUNT_NOT_AVAILABLE');
        return tx
          .insert(publicationIntent)
          .values({
            userId,
            ...input,
            description: input.description ?? null,
            scheduledAt: input.scheduledAt ?? null,
          })
          .returning();
      }),
    findForUser: (userId: string, id: string) =>
      db
        .select()
        .from(publicationIntent)
        .where(and(eq(publicationIntent.userId, userId), eq(publicationIntent.id, id)))
        .limit(1),
    listForUser: (userId: string) =>
      db.select().from(publicationIntent).where(eq(publicationIntent.userId, userId)),
    update: (
      userId: string,
      id: string,
      revision: number,
      values: Omit<IntentInput, 'videoId' | 'publishingAccountId' | 'platform'>,
    ) =>
      db
        .update(publicationIntent)
        .set({ ...values, revision: revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(publicationIntent.userId, userId),
            eq(publicationIntent.id, id),
            eq(publicationIntent.revision, revision),
          ),
        )
        .returning(),
    beginPreview: (
      userId: string,
      id: string,
      revision: number,
      preview: { objectKey: string; contentType: string; sizeBytes: number },
      preserveReadyPreview: boolean,
    ) =>
      db
        .update(publicationIntent)
        .set(
          preserveReadyPreview
            ? {
                pendingPreviewObjectKey: preview.objectKey,
                pendingPreviewContentType: preview.contentType,
                pendingPreviewSizeBytes: preview.sizeBytes,
                revision: revision + 1,
                updatedAt: new Date(),
              }
            : {
                previewObjectKey: preview.objectKey,
                previewContentType: preview.contentType,
                previewSizeBytes: preview.sizeBytes,
                previewState: 'pending',
                pendingPreviewObjectKey: null,
                pendingPreviewContentType: null,
                pendingPreviewSizeBytes: null,
                revision: revision + 1,
                updatedAt: new Date(),
              },
        )
        .where(
          and(
            eq(publicationIntent.userId, userId),
            eq(publicationIntent.id, id),
            eq(publicationIntent.revision, revision),
          ),
        )
        .returning(),
    completePreview: (
      userId: string,
      id: string,
      revision: number,
      replaceReadyPreview: boolean,
      readyPreview: { objectKey: string; contentType: string; sizeBytes: number },
    ) =>
      db
        .update(publicationIntent)
        .set(
          replaceReadyPreview
            ? {
                previewObjectKey: readyPreview.objectKey,
                previewContentType: readyPreview.contentType,
                previewSizeBytes: readyPreview.sizeBytes,
                previewState: 'ready',
                pendingPreviewObjectKey: null,
                pendingPreviewContentType: null,
                pendingPreviewSizeBytes: null,
                revision: revision + 1,
                updatedAt: new Date(),
              }
            : {
                previewObjectKey: readyPreview.objectKey,
                previewContentType: readyPreview.contentType,
                previewSizeBytes: readyPreview.sizeBytes,
                previewState: 'ready',
                revision: revision + 1,
                updatedAt: new Date(),
              },
        )
        .where(
          and(
            eq(publicationIntent.userId, userId),
            eq(publicationIntent.id, id),
            eq(publicationIntent.revision, revision),
            eq(publicationIntent.previewState, replaceReadyPreview ? 'ready' : 'pending'),
          ),
        )
        .returning(),
    removePreview: (userId: string, id: string, revision: number) =>
      db
        .update(publicationIntent)
        .set({
          previewObjectKey: null,
          previewContentType: null,
          previewSizeBytes: null,
          previewState: null,
          pendingPreviewObjectKey: null,
          pendingPreviewContentType: null,
          pendingPreviewSizeBytes: null,
          revision: revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publicationIntent.userId, userId),
            eq(publicationIntent.id, id),
            eq(publicationIntent.revision, revision),
          ),
        )
        .returning(),
  };
}
