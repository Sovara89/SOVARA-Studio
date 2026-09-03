import { describe, expect, test, vi } from 'vitest';
import {
  createPkcePair,
  createVkOAuthProvider,
  createYouTubeOAuthProvider,
  OAuthProviderError,
} from './oauth.js';

describe('OAuth provider adapters', () => {
  test('creates an RFC 7636 S256 pair', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('builds the YouTube offline authorization request and exchanges tokens', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'scope-a scope-b',
        }),
        { status: 200 },
      ),
    );
    const provider = createYouTubeOAuthProvider({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://studio.example/oauth/callback',
      fetch: request,
    });
    const authorization = new URL(
      provider.authorizationUrl({ state: 'state', codeChallenge: 'challenge' }),
    );
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const tokens = await provider.exchangeCode({
      code: 'code',
      codeVerifier: 'verifier',
      state: 'state',
    });
    expect(tokens).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresInSeconds: 3600,
    });
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain('code_verifier=verifier');
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain('client_secret=secret');
  });

  test('uses VK ID device binding and rotates refresh tokens', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'rotated',
          expires_in: 3600,
          user_id: 123,
        }),
        { status: 200 },
      ),
    );
    const provider = createVkOAuthProvider({
      clientId: 'client',
      serviceToken: 'service',
      redirectUri: 'https://studio.example/vk',
      fetch: request,
    });
    const tokens = await provider.refreshToken({ refreshToken: 'old', providerDeviceId: 'device' });
    expect(tokens).toMatchObject({
      accessToken: 'access',
      refreshToken: 'rotated',
      providerDeviceId: 'device',
    });
    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('device_id=device');
    expect(body).toContain('service_token=service');
    expect(body).toContain('grant_type=refresh_token');
  });

  test('rejects VK refresh without the required device binding', async () => {
    const provider = createVkOAuthProvider({
      clientId: 'client',
      serviceToken: 'service',
      redirectUri: 'https://studio.example/vk',
      fetch: vi.fn<typeof fetch>(),
    });
    await expect(provider.refreshToken({ refreshToken: 'old' })).rejects.toMatchObject({
      code: 'missing_device_id',
      kind: 'definite_local_failure',
    });
  });

  test('does not expose provider response bodies in errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'access-secret' }),
          { status: 400 },
        ),
      );
    const provider = createYouTubeOAuthProvider({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://studio.example/callback',
      fetch: request,
    });
    await expect(provider.refreshToken({ refreshToken: 'refresh-secret' })).rejects.toMatchObject({
      name: 'OAuthProviderError',
      message: expect.not.stringContaining('access-secret'),
    } satisfies Partial<OAuthProviderError>);
  });

  test.each([
    { items: [], code: 'channel_not_found' },
    { items: [{ id: 'channel-1', snippet: { title: 'Channel 1' } }], code: undefined },
    {
      items: [
        { id: 'channel-1', snippet: { title: 'Channel 1' } },
        { id: 'channel-2', snippet: { title: 'Channel 2' } },
      ],
      code: 'ambiguous_identity',
    },
  ])('resolves YouTube identity only when unambiguous', async ({ items, code }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ items }), { status: 200 }));
    const provider = createYouTubeOAuthProvider({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://studio.example/callback',
      fetch: request,
    });
    if (code) {
      await expect(provider.identity('access')).rejects.toMatchObject({ code });
    } else {
      await expect(provider.identity('access')).resolves.toMatchObject({
        providerAccountId: 'channel-1',
      });
    }
  });

  test.each([
    { status: 400, body: { error: 'invalid_grant' }, kind: 'definite_response' },
    { status: 400, body: { error: 'invalid_client' }, kind: 'definite_response' },
    {
      status: 500,
      body: { error: 'server_error', error_description: 'server-secret' },
      kind: 'transient_response',
    },
  ])(
    'classifies provider refresh responses without exposing bodies',
    async ({ status, body, kind }) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status }));
      const provider = createYouTubeOAuthProvider({
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://studio.example/callback',
        fetch: request,
      });
      await expect(provider.refreshToken({ refreshToken: 'refresh-secret' })).rejects.toMatchObject(
        {
          kind,
          message: expect.not.stringContaining('server-secret'),
        },
      );
    },
  );
});
