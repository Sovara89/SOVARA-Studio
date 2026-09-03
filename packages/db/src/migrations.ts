import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { DatabaseHandle } from './client.js';

export async function applyMigrations(database: DatabaseHandle) {
  await migrate(database.db, { migrationsFolder: 'packages/db/drizzle' });
}
