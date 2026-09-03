import { createDatabase } from './client.js';
import { applyMigrations } from './migrations.js';

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error('MIGRATION_DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(connectionString);
  try {
    await applyMigrations(database);
  } finally {
    await database.pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Database migration failed');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
