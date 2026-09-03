export type OAuthPlatform = 'youtube' | 'vk';

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scopes: string[];
  providerAccountId?: string;
  providerDeviceId?: string;
  idToken?: string;
};

export type OAuthIdentity = { providerAccountId: string; displayName: string };

export type OAuthProvider = {
  readonly platform: OAuthPlatform;
  readonly scopes: readonly string[];
  authorizationUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    state: string;
    providerDeviceId?: string;
  }): Promise<OAuthTokenSet>;
  refreshToken(input: {
    refreshToken: string;
    providerDeviceId?: string;
    signal?: AbortSignal;
  }): Promise<OAuthTokenSet>;
  identity(accessToken: string): Promise<OAuthIdentity>;
  revoke(accessToken: string, signal?: AbortSignal): Promise<void>;
};

export type OAuthProviderErrorKind =
  'definite_response' | 'definite_local_failure' | 'transient_response' | 'ambiguous';

export class OAuthProviderError extends Error {
  constructor(
    readonly platform: OAuthPlatform,
    readonly status: number,
    readonly code = 'provider_error',
    readonly kind: OAuthProviderErrorKind = status === 408 || status === 429 || status >= 500
      ? 'transient_response'
      : 'definite_response',
  ) {
    super(`OAuth provider request failed (${platform}, ${status}, ${code})`);
    this.name = 'OAuthProviderError';
  }
}

type FetchLike = typeof fetch;

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function createPkcePair() {
  const verifier = randomBase64Url(32);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return {
    verifier,
    challenge: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
  };
}

async function readJson(response: Response, platform: OAuthPlatform) {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const code =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : 'provider_error';
    throw new OAuthProviderError(
      platform,
      response.status,
      code,
      response.status === 408 || response.status === 429 || response.status >= 500
        ? 'transient_response'
        : 'definite_response',
    );
  }
  if (!value || typeof value !== 'object')
    throw new OAuthProviderError(platform, response.status, 'invalid_response');
  return value as Record<string, unknown>;
}

async function requestJson(
  request: FetchLike,
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
  platform: OAuthPlatform,
) {
  let response: Response;
  try {
    response = await request(input, init);
  } catch {
    throw new OAuthProviderError(platform, 0, 'network_error', 'ambiguous');
  }
  return readJson(response, platform);
}

function requiredString(value: unknown, platform: OAuthPlatform, field: string) {
  if (typeof value !== 'string' || value.length === 0)
    throw new OAuthProviderError(platform, 200, `invalid_${field}`);
  return value;
}

function tokenSet(value: Record<string, unknown>, platform: OAuthPlatform): OAuthTokenSet {
  return {
    accessToken: requiredString(value.access_token, platform, 'access_token'),
    refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
    expiresInSeconds: typeof value.expires_in === 'number' ? value.expires_in : 3600,
    scopes: typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : [],
    idToken: typeof value.id_token === 'string' ? value.id_token : undefined,
    providerAccountId:
      typeof value.user_id === 'string' || typeof value.user_id === 'number'
        ? String(value.user_id)
        : undefined,
  };
}

function formBody(values: Record<string, string | undefined>) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) form.set(key, value);
  return form;
}

export function createYouTubeOAuthProvider(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
}): OAuthProvider {
  const request = config.fetch ?? fetch;
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.upload',
  ];
  return {
    platform: 'youtube',
    scopes,
    authorizationUrl: ({ state, codeChallenge }) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    exchangeCode: async ({ code, codeVerifier }) =>
      tokenSet(
        await readJson(
          await request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: formBody({
              code,
              client_id: config.clientId,
              client_secret: config.clientSecret,
              redirect_uri: config.redirectUri,
              grant_type: 'authorization_code',
              code_verifier: codeVerifier,
            }),
          }),
          'youtube',
        ),
        'youtube',
      ),
    refreshToken: async ({ refreshToken, signal }) =>
      tokenSet(
        await requestJson(
          request,
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            signal,
            body: formBody({
              refresh_token: refreshToken,
              client_id: config.clientId,
              client_secret: config.clientSecret,
              grant_type: 'refresh_token',
            }),
          },
          'youtube',
        ),
        'youtube',
      ),
    identity: async (accessToken) => {
      const value = await requestJson(
        request,
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
        'youtube',
      );
      const viableChannels = Array.isArray(value.items)
        ? value.items.filter(
            (item): item is { id: string; snippet?: { title?: unknown } } =>
              !!item &&
              typeof item === 'object' &&
              'id' in item &&
              typeof item.id === 'string' &&
              item.id.length > 0,
          )
        : [];
      if (viableChannels.length === 0)
        throw new OAuthProviderError('youtube', 200, 'channel_not_found');
      if (viableChannels.length > 1)
        throw new OAuthProviderError('youtube', 200, 'ambiguous_identity');
      const item = viableChannels[0]!;
      const channel = item as { id?: unknown; snippet?: { title?: unknown } };
      return {
        providerAccountId: requiredString(channel.id, 'youtube', 'channel_id'),
        displayName:
          typeof channel.snippet?.title === 'string' ? channel.snippet.title : 'YouTube channel',
      };
    },
    revoke: async (accessToken, signal) => {
      await requestJson(
        request,
        'https://oauth2.googleapis.com/revoke',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          signal,
          body: formBody({ token: accessToken }),
        },
        'youtube',
      ).catch((error) => {
        if (!(error instanceof OAuthProviderError) || error.status !== 400) throw error;
      });
    },
  };
}

export function createVkOAuthProvider(config: {
  clientId: string;
  serviceToken: string;
  redirectUri: string;
  fetch?: FetchLike;
}): OAuthProvider {
  const request = config.fetch ?? fetch;
  const scopes = ['vkid.personal_info', 'video'];
  return {
    platform: 'vk',
    scopes,
    authorizationUrl: ({ state, codeChallenge }) => {
      const url = new URL('https://id.vk.ru/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: scopes.join(' '),
      }).toString();
      return url.toString();
    },
    exchangeCode: async ({ code, codeVerifier, state, providerDeviceId }) => {
      const result = tokenSet(
        await readJson(
          await request('https://id.vk.ru/oauth2/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: formBody({
              grant_type: 'authorization_code',
              code_verifier: codeVerifier,
              redirect_uri: config.redirectUri,
              code,
              client_id: config.clientId,
              device_id: providerDeviceId,
              state,
              service_token: config.serviceToken,
            }),
          }),
          'vk',
        ),
        'vk',
      );
      return { ...result, providerDeviceId };
    },
    refreshToken: async ({ refreshToken, providerDeviceId, signal }) => {
      if (!providerDeviceId)
        throw new OAuthProviderError('vk', 0, 'missing_device_id', 'definite_local_failure');
      const result = tokenSet(
        await requestJson(
          request,
          'https://id.vk.ru/oauth2/auth',
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            signal,
            body: formBody({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              client_id: config.clientId,
              device_id: providerDeviceId,
              state: randomBase64Url(24),
              service_token: config.serviceToken,
            }),
          },
          'vk',
        ),
        'vk',
      );
      return { ...result, providerDeviceId };
    },
    identity: async (accessToken) => {
      const value = await requestJson(
        request,
        'https://id.vk.ru/oauth2/user_info',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: formBody({ access_token: accessToken, client_id: config.clientId }),
        },
        'vk',
      );
      const user = value.user;
      if (!user || typeof user !== 'object')
        throw new OAuthProviderError('vk', 200, 'user_not_found');
      const data = user as { user_id?: unknown; first_name?: unknown; last_name?: unknown };
      return {
        providerAccountId: requiredString(
          data.user_id === undefined ? undefined : String(data.user_id),
          'vk',
          'user_id',
        ),
        displayName:
          [data.first_name, data.last_name]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join(' ') || 'VK account',
      };
    },
    revoke: async (accessToken, signal) => {
      await requestJson(
        request,
        'https://id.vk.ru/oauth2/logout',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          signal,
          body: formBody({ client_id: config.clientId, access_token: accessToken }),
        },
        'vk',
      );
    },
  };
}
