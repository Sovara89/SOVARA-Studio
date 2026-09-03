import { describe, expect, test } from 'vitest';
import { parseOAuthConfiguration } from './oauth-config.js';

describe('OAuth configuration', () => {
  test('keeps providers disabled when credentials are absent', () => {
    expect(parseOAuthConfiguration({}, 'http://localhost:3000')).toEqual({
      youtube: undefined,
      vk: undefined,
    });
  });

  test('derives callback URLs and rejects partial credentials', () => {
    expect(() =>
      parseOAuthConfiguration({ YOUTUBE_CLIENT_ID: 'client' }, 'http://localhost:3000'),
    ).toThrow('YouTube OAuth configuration requires client ID and client secret');
    expect(
      parseOAuthConfiguration(
        { YOUTUBE_CLIENT_ID: 'client', YOUTUBE_CLIENT_SECRET: 'secret' },
        'http://localhost:3000',
      ).youtube,
    ).toEqual({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/api/publishing-accounts/youtube/oauth/callback',
    });
  });
});
