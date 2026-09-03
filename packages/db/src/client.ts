import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { authSchema } from './schema/index.js';
import { multipartUpload, uploadPart } from './schema/multipart-uploads.js';
import { publication, publicationAttempt } from './schema/publications.js';
import { publishingAccount } from './schema/publishing-accounts.js';
import { oauthTransaction } from './schema/oauth-transactions.js';
import { video } from './schema/videos.js';
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  const schema = {
    ...authSchema,
    publishingAccount,
    oauthTransaction,
    video,
    multipartUpload,
    uploadPart,
    publication,
    publicationAttempt,
  };
  return { db: drizzle({ client: pool, schema }), pool, schema };
}
export type DatabaseHandle = ReturnType<typeof createDatabase>;
