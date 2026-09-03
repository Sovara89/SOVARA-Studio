import { z } from 'zod';

const OAuthEnvironmentSchema = z.object({
  YOUTUBE_CLIENT_ID: z.string().min(1).optional(),
  YOUTUBE_CLIENT_SECRET: z.string().min(1).optional(),
  YOUTUBE_REDIRECT_URI: z.string().url().optional(),
  VK_CLIENT_ID: z.string().min(1).optional(),
  VK_SERVICE_TOKEN: z.string().min(1).optional(),
  VK_REDIRECT_URI: z.string().url().optional(),
});

export type OAuthConfiguration = {
  youtube?: { clientId: string; clientSecret: string; redirectUri: string };
  vk?: { clientId: string; serviceToken: string; redirectUri: string };
};

export function parseOAuthConfiguration(
  values: Record<string, unknown>,
  appOrigin: string,
): OAuthConfiguration {
  const parsed = OAuthEnvironmentSchema.parse(values);
  const youtubeValues = [parsed.YOUTUBE_CLIENT_ID, parsed.YOUTUBE_CLIENT_SECRET];
  const vkValues = [parsed.VK_CLIENT_ID, parsed.VK_SERVICE_TOKEN];
  if (youtubeValues.some(Boolean) && youtubeValues.some((value) => !value))
    throw new Error('YouTube OAuth configuration requires client ID and client secret');
  if (vkValues.some(Boolean) && vkValues.some((value) => !value))
    throw new Error('VK OAuth configuration requires client ID and service token');
  return {
    youtube:
      parsed.YOUTUBE_CLIENT_ID && parsed.YOUTUBE_CLIENT_SECRET
        ? {
            clientId: parsed.YOUTUBE_CLIENT_ID,
            clientSecret: parsed.YOUTUBE_CLIENT_SECRET,
            redirectUri:
              parsed.YOUTUBE_REDIRECT_URI ??
              `${appOrigin}/api/publishing-accounts/youtube/oauth/callback`,
          }
        : undefined,
    vk:
      parsed.VK_CLIENT_ID && parsed.VK_SERVICE_TOKEN
        ? {
            clientId: parsed.VK_CLIENT_ID,
            serviceToken: parsed.VK_SERVICE_TOKEN,
            redirectUri:
              parsed.VK_REDIRECT_URI ?? `${appOrigin}/api/publishing-accounts/vk/oauth/callback`,
          }
        : undefined,
  };
}
