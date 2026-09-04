import { describe, expect, test, vi } from 'vitest';
import {
  createPublicationIntentService,
  PublicationIntentError,
} from './publication-intent-service.js';

const intentId = 'c4c4e30-e24e-4cde-9534-a43f4b3f98e8';
const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: intentId,
    userId: 'owner-id',
    videoId: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
    platform: 'youtube',
    publishingAccountId: '5c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
    mode: 'DRAFT',
    title: 'Title',
    description: null,
    link: 'https://vk.com/sovara_news',
    createCommunityPost: false,
    scheduledAt: null,
    previewObjectKey: 'previews/old',
    previewContentType: 'image/png',
    previewSizeBytes: 12,
    previewState: 'ready',
    pendingPreviewObjectKey: 'previews/candidate',
    pendingPreviewContentType: 'image/webp',
    pendingPreviewSizeBytes: 16,
    revision: 4,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as never;

describe('publication intent preview service', () => {
  test('returns the existing publication after a duplicate publish request', async () => {
    const publications = {
      findForUserByVideoAndAccount: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '7c4f8e30-e24e-4cde-9534-a43f4b3f98e8' }]),
      createOwnedPublication: vi.fn().mockRejectedValue({ code: '23505' }),
    } as never;
    const service = createPublicationIntentService({
      intents: { findForUser: vi.fn().mockResolvedValue([row()]) } as never,
      previewStorage: {} as never,
      publications,
    });

    await expect(service.publish('owner-id', intentId, 4)).resolves.toEqual({
      publicationId: '7c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
    });
    expect(publications.createOwnedPublication).toHaveBeenCalledTimes(1);
  });

  test('removes only an owner revision-matched preview, then cleans its objects', async () => {
    const removePreview = vi.fn().mockResolvedValue([
      row({
        previewObjectKey: null,
        previewContentType: null,
        previewSizeBytes: null,
        previewState: null,
        pendingPreviewObjectKey: null,
        pendingPreviewContentType: null,
        pendingPreviewSizeBytes: null,
        revision: 5,
      }),
    ]);
    const intents = { findForUser: vi.fn().mockResolvedValue([row()]), removePreview } as never;
    const previewStorage = { deleteObject: vi.fn().mockResolvedValue(undefined) } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.removePreview('owner-id', intentId, 4)).resolves.toMatchObject({
      preview: null,
      revision: 5,
    });
    expect(removePreview).toHaveBeenCalledWith('owner-id', intentId, 4);
    expect(previewStorage.deleteObject).toHaveBeenCalledTimes(2);
    expect(previewStorage.deleteObject).toHaveBeenCalledWith('previews/old');
    expect(previewStorage.deleteObject).toHaveBeenCalledWith('previews/candidate');
  });

  test('does not delete preview objects when revision-CAS removal fails', async () => {
    const intents = {
      findForUser: vi.fn().mockResolvedValue([row()]),
      removePreview: vi.fn().mockResolvedValue([]),
    } as never;
    const previewStorage = { deleteObject: vi.fn() } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.removePreview('owner-id', intentId, 3)).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<PublicationIntentError>);
    expect(previewStorage.deleteObject).not.toHaveBeenCalled();
  });

  test('returns the authoritative unlink when storage cleanup fails and logs no provider error', async () => {
    const removePreview = vi.fn().mockResolvedValue([
      row({
        previewObjectKey: null,
        previewContentType: null,
        previewSizeBytes: null,
        previewState: null,
        pendingPreviewObjectKey: null,
        pendingPreviewContentType: null,
        pendingPreviewSizeBytes: null,
        revision: 5,
      }),
    ]);
    const onPreviewCleanupFailure = vi.fn();
    const intents = { findForUser: vi.fn().mockResolvedValue([row()]), removePreview } as never;
    const previewStorage = {
      deleteObject: vi.fn().mockRejectedValue(new Error('storage token=secret')),
    } as never;
    const service = createPublicationIntentService({
      intents,
      previewStorage,
      onPreviewCleanupFailure,
    });

    await expect(service.removePreview('owner-id', intentId, 4)).resolves.toMatchObject({
      preview: null,
      revision: 5,
    });
    await vi.waitFor(() => expect(onPreviewCleanupFailure).toHaveBeenCalledWith({ intentId }));
    expect(onPreviewCleanupFailure).toHaveBeenCalledTimes(1);
  });

  test('preserves an explicitly cleared metadata link on an unrelated update', async () => {
    const current = row({ link: null });
    const update = vi.fn().mockResolvedValue([row({ link: null, revision: 5 })]);
    const intents = { findForUser: vi.fn().mockResolvedValue([current]), update } as never;
    const service = createPublicationIntentService({ intents, previewStorage: {} as never });

    await service.update('owner-id', intentId, {
      mode: 'DRAFT',
      title: 'Updated title',
      description: null,
      createCommunityPost: false,
      revision: 4,
    });
    expect(update).toHaveBeenCalledWith(
      'owner-id',
      intentId,
      4,
      expect.objectContaining({ link: null }),
    );
  });

  test('does not delete a foreign intent preview', async () => {
    const intents = { findForUser: vi.fn().mockResolvedValue([]), removePreview: vi.fn() } as never;
    const previewStorage = { deleteObject: vi.fn() } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.removePreview('other-user-id', intentId, 4)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<PublicationIntentError>);
    expect(intents.removePreview).not.toHaveBeenCalled();
    expect(previewStorage.deleteObject).not.toHaveBeenCalled();
  });

  test('keeps a ready preview until its replacement is verified, then removes the old object', async () => {
    const current = row();
    const completePreview = vi
      .fn()
      .mockResolvedValue([row({ revision: 5, previewObjectKey: 'previews/ready-copy' })]);
    const intents = {
      findForUser: vi.fn().mockResolvedValue([current]),
      completePreview,
    } as never;
    const previewStorage = {
      headObject: vi.fn().mockResolvedValue({
        contentType: 'image/webp; charset=binary',
        contentLength: 16,
        etag: 'staging-etag',
      }),
      finalizeStagedObject: vi.fn().mockResolvedValue(undefined),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.completePreview('owner-id', intentId, 4)).resolves.toMatchObject({
      preview: { state: 'ready', contentType: 'image/png' },
      revision: 5,
    });
    expect(previewStorage.headObject).toHaveBeenCalledWith('previews/candidate');
    expect(previewStorage.finalizeStagedObject).toHaveBeenCalledWith({
      stagingObjectKey: 'previews/candidate',
      readyObjectKey: expect.stringMatching(/\/ready\//),
      etag: 'staging-etag',
    });
    expect(completePreview).toHaveBeenCalledWith(
      'owner-id',
      intentId,
      4,
      true,
      expect.objectContaining({ objectKey: expect.stringMatching(/\/ready\//) }),
    );
    expect(previewStorage.deleteObject).toHaveBeenCalledWith('previews/old');
  });

  test('does not replace a ready preview when its candidate fails verification', async () => {
    const completePreview = vi.fn();
    const intents = {
      findForUser: vi.fn().mockResolvedValue([row()]),
      completePreview,
    } as never;
    const previewStorage = {
      headObject: vi.fn().mockResolvedValue({
        contentType: 'image/webp',
        contentLength: 15,
      }),
      finalizeStagedObject: vi.fn(),
      deleteObject: vi.fn(),
    } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.completePreview('owner-id', intentId, 4)).rejects.toMatchObject({
      code: 'PREVIEW_INVALID',
    } satisfies Partial<PublicationIntentError>);
    expect(completePreview).not.toHaveBeenCalled();
    expect(previewStorage.deleteObject).not.toHaveBeenCalled();
  });

  test('rejects a staging object changed after verification and never marks it ready', async () => {
    const completePreview = vi.fn();
    const intents = {
      findForUser: vi.fn().mockResolvedValue([row()]),
      completePreview,
    } as never;
    const previewStorage = {
      headObject: vi.fn().mockResolvedValue({
        contentType: 'image/webp',
        contentLength: 16,
        etag: 'v1',
      }),
      finalizeStagedObject: vi.fn().mockRejectedValue(new Error('precondition failed')),
      deleteObject: vi.fn(),
    } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await expect(service.completePreview('owner-id', intentId, 4)).rejects.toMatchObject({
      code: 'PREVIEW_INVALID',
    } satisfies Partial<PublicationIntentError>);
    expect(completePreview).not.toHaveBeenCalled();
  });

  test('cleans a superseded unverified candidate only after its replacement is recorded', async () => {
    const current = row({ pendingPreviewObjectKey: 'previews/abandoned-candidate' });
    const beginPreview = vi.fn().mockResolvedValue([row({ revision: 5 })]);
    const intents = { findForUser: vi.fn().mockResolvedValue([current]), beginPreview } as never;
    const previewStorage = {
      presignPut: vi.fn().mockResolvedValue('https://storage.example/upload'),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    } as never;
    const service = createPublicationIntentService({ intents, previewStorage });

    await service.preparePreview('owner-id', intentId, {
      contentType: 'image/jpeg',
      sizeBytes: 10,
      revision: 4,
    });
    expect(beginPreview).toHaveBeenCalledWith(
      'owner-id',
      intentId,
      4,
      expect.objectContaining({ contentType: 'image/jpeg', sizeBytes: 10 }),
      true,
    );
    expect(previewStorage.deleteObject).toHaveBeenCalledWith('previews/abandoned-candidate');
  });
});
