import { z } from 'zod';
import { parseCredentialConfiguration } from './credential-config.js';
import { parseStorageConfiguration } from './storage-config.js';
import { parseOAuthConfiguration } from './oauth-config.js';

const EnvironmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  CREDENTIAL_ENCRYPTION_KEYS: z.string().min(1),
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
  YOUTUBE_CLIENT_ID: z.string().min(1).optional(),
  YOUTUBE_CLIENT_SECRET: z.string().min(1).optional(),
  YOUTUBE_REDIRECT_URI: z.string().url().optional(),
  VK_CLIENT_ID: z.string().min(1).optional(),
  VK_SERVICE_TOKEN: z.string().min(1).optional(),
  VK_REDIRECT_URI: z.string().url().optional(),
  VK_GROUP_ID: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
});

export const environment = EnvironmentSchema.parse(process.env);
export const API_PORT = environment.API_PORT;
export const {
  DATABASE_URL,
  AUTH_SECRET,
  APP_ORIGIN,
  CREDENTIAL_ENCRYPTION_KEYS,
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
} = environment;
export const credentialConfiguration = parseCredentialConfiguration(
  CREDENTIAL_ENCRYPTION_KEYS,
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
);
export const loadStorageConfiguration = () => parseStorageConfiguration();
export const oauthConfiguration = parseOAuthConfiguration(environment, APP_ORIGIN);
