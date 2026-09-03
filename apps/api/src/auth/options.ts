import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import type { createDatabase } from '@sovara-studio/db';

export function createAuth(
  database: ReturnType<typeof createDatabase>,
  config: { secret: string; appOrigin: string; provisioning?: boolean },
) {
  return betterAuth({
    database: drizzleAdapter(database.db, {
      provider: 'pg',
      schema: database.schema,
      usePlural: false,
    }),
    baseURL: config.appOrigin,
    secret: config.secret,
    trustedOrigins: [config.appOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.provisioning,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: 'sovara_studio',
      useSecureCookies: new URL(config.appOrigin).protocol === 'https:',
      crossSubDomainCookies: { enabled: false },
      database: { generateId: 'uuid' },
    },
    account: Object.assign({ identityStrategy: 'provider-id' }),
  });
}
