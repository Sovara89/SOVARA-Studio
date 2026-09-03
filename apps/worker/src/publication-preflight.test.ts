import { describe, expect, test, vi } from 'vitest';
import { createPublicationPreflight } from './publication-preflight.js';

function fixture(scopes: readonly string[], platform: 'youtube' | 'vk' = 'youtube') {
  const getAccessToken = vi.fn().mockResolvedValue('access-token');
  const getAccessTokenSnapshot = vi.fn(
    async (
      _userId: string,
      _accountId: string,
      options?: { forceRefresh?: boolean; expectedCredentialRevision?: number },
    ) => ({
      accessToken: options?.forceRefresh ? 'refreshed-access-token' : 'access-token',
      credentialRevision: options?.forceRefresh ? 4 : 3,
      providerAccountId: 'channel-1',
      scopes,
    }),
  );
  const preflight = createPublicationPreflight({
    accounts: {
      findByIdForUser: vi.fn().mockResolvedValue([
        {
          id: 'account-1',
          userId: 'user-1',
          platform,
          status: 'active',
          providerAccountId: 'channel-1',
        },
      ]),
    } as never,
    videos: {
      findByIdForUser: vi
        .fn()
        .mockResolvedValue([{ state: 'ready', verifiedSizeBytes: 10, contentType: 'video/mp4' }]),
    } as never,
    credentials: {
      getAccessTokenSnapshot,
      getAccessToken,
    },
    createMediaSource: () => ({
      sizeBytes: 10,
      contentType: 'video/mp4',
      openReadStream: vi.fn(),
    }),
  });
  return { preflight, getAccessToken, getAccessTokenSnapshot };
}

const publication = {
  userId: 'user-1',
  publishingAccountId: 'account-1',
  platform: 'youtube',
  videoId: 'video-1',
} as never;

describe('publication preflight', () => {
  test('blocks YouTube publication when required scopes are absent', async () => {
    const { preflight } = fixture(['https://www.googleapis.com/auth/youtube.upload']);
    await expect(preflight(publication, new AbortController().signal)).rejects.toMatchObject({
      code: 'YOUTUBE_SCOPES_INSUFFICIENT',
      disposition: 'reauthorization_required',
    });
  });

  test('returns the authoritative channel and preserves forced refresh capability', async () => {
    const { preflight, getAccessToken, getAccessTokenSnapshot } = fixture([
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.upload',
    ]);
    const result = await preflight(publication, new AbortController().signal);
    expect(result.credential.providerAccountId).toBe('channel-1');
    expect(result.credential.scopes).toHaveLength(2);
    await expect(result.credential.getAccessToken({ forceRefresh: true })).resolves.toBe(
      'refreshed-access-token',
    );
    expect(getAccessTokenSnapshot).toHaveBeenLastCalledWith('user-1', 'account-1', {
      forceRefresh: true,
      expectedCredentialRevision: 3,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  test('blocks VK publication when the actual video scope is absent', async () => {
    const { preflight } = fixture(['vkid.personal_info'], 'vk');
    await expect(
      preflight({ ...publication, platform: 'vk' } as never, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'VK_SCOPES_INSUFFICIENT',
      disposition: 'reauthorization_required',
    });
  });
});
