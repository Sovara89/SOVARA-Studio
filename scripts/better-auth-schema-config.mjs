import { betterAuth } from 'better-auth';

export default betterAuth({
  secret: process.env.AUTH_SECRET ?? 'schema-check-only-secret-32-bytes-long',
  baseURL: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  session: {
    cookieCache: { enabled: false },
  },
  account: { identityStrategy: 'provider-id' },
  advanced: { database: { generateId: 'uuid' }, cookiePrefix: 'sovara_studio' },
});
