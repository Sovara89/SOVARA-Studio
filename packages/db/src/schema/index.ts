export * from './auth.generated.js';
export * from './publishing-accounts.js';
export * from './videos.js';
export * from './multipart-uploads.js';
export * from './publications.js';
export * from './oauth-transactions.js';
export * from './publication-intents.js';
import { user, session, account, verification } from './auth.generated.js';
export const authSchema = { user, session, account, verification };
