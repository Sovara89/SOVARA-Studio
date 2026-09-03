import { describe, expect, test } from 'vitest';
import { publicationJobPayloadSchema } from '@sovara-studio/contracts';
import { publicationJobId } from './publication-queue.js';

const publicationId = '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8';

describe('publication queue contract', () => {
  test('creates a revision-scoped deterministic job ID', () => {
    expect(publicationJobId({ publicationId, expectedRevision: 7 })).toBe(
      `publication-${publicationId}-r7`,
    );
    expect(publicationJobId({ publicationId, expectedRevision: 8 })).not.toBe(
      publicationJobId({ publicationId, expectedRevision: 7 }),
    );
  });

  test('rejects malformed and sensitive queue payloads', () => {
    expect(
      publicationJobPayloadSchema.safeParse({ publicationId, expectedRevision: 0 }).success,
    ).toBe(true);
    expect(
      publicationJobPayloadSchema.safeParse({ publicationId, expectedRevision: -1 }).success,
    ).toBe(false);
    expect(
      publicationJobPayloadSchema.safeParse({
        publicationId,
        expectedRevision: 0,
        userId: 'owner-id',
      }).success,
    ).toBe(false);
    expect(
      publicationJobPayloadSchema.safeParse({
        publicationId: 'not-a-uuid',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });
});
