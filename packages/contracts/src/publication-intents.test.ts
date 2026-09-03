import { describe, expect, test } from 'vitest';
import {
  createPublicationIntentRequestSchema,
  updatePublicationIntentRequestSchema,
} from './publication-intents.js';
const base = {
  videoId: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  publishingAccountId: '6fb4dc69-1981-47ef-9d4f-f0f7dd8b2f3a',
  platform: 'vk' as const,
  mode: 'DRAFT' as const,
  title: 'News',
  createCommunityPost: false,
};
describe('publication intent contract', () => {
  test('uses the safe VK link default and stores no execution state', () => {
    const parsed = createPublicationIntentRequestSchema.parse(base);
    expect(parsed.link).toBe('https://vk.com/sovara_news');
    expect(parsed).not.toHaveProperty('state');
  });
  test('permits an intentional link clear, but only accepts bounded credential-free HTTPS VK URLs', () => {
    expect(createPublicationIntentRequestSchema.parse({ ...base, link: null }).link).toBeNull();
    for (const link of [
      'http://vk.com/sovara_news',
      'https://example.com/vk',
      'https://token@vk.com/sovara_news',
      `https://vk.com/${'x'.repeat(2040)}`,
    ]) {
      expect(createPublicationIntentRequestSchema.safeParse({ ...base, link }).success).toBe(false);
    }
    expect(
      createPublicationIntentRequestSchema.safeParse({
        ...base,
        link: 'https://www.vk.com/sovara_news?from=studio',
      }).success,
    ).toBe(true);
  });
  test('does not default an omitted link during an update', () => {
    const parsed = updatePublicationIntentRequestSchema.parse({
      mode: base.mode,
      title: base.title,
      createCommunityPost: false,
      revision: 0,
    });
    expect(parsed).not.toHaveProperty('link');
    expect(updatePublicationIntentRequestSchema.parse({ ...parsed, link: null }).link).toBeNull();
  });
  test('requires UTC scheduling and constrains VK description', () => {
    expect(
      createPublicationIntentRequestSchema.safeParse({
        ...base,
        mode: 'SCHEDULED',
        scheduledAt: '2026-09-01T10:00:00+03:00',
      }).success,
    ).toBe(false);
    expect(
      createPublicationIntentRequestSchema.safeParse({ ...base, description: 'x'.repeat(5001) })
        .success,
    ).toBe(false);
  });
  test('accepts the explicit UTC timestamp produced from a datetime-local browser value', () => {
    expect(
      createPublicationIntentRequestSchema.safeParse({
        ...base,
        mode: 'SCHEDULED',
        scheduledAt: '2026-09-01T07:00:00.000Z',
      }).success,
    ).toBe(true);
  });
  test('rejects invalid schedule mode combinations on update as well as create', () => {
    const update = {
      mode: base.mode,
      title: base.title,
      createCommunityPost: base.createCommunityPost,
      revision: 0,
    };
    expect(
      updatePublicationIntentRequestSchema.safeParse({ ...update, mode: 'SCHEDULED' }).success,
    ).toBe(false);
    expect(
      updatePublicationIntentRequestSchema.safeParse({
        ...update,
        scheduledAt: '2026-09-01T07:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      updatePublicationIntentRequestSchema.safeParse({
        ...update,
        mode: 'SCHEDULED',
        scheduledAt: '2026-09-01T07:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
