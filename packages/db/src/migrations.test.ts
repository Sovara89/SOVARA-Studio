import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const migrationPath = resolve('packages/db/drizzle/0002_ancient_bloodstrike.sql');
const journalPath = resolve('packages/db/drizzle/meta/_journal.json');

describe('migration 0002 compatibility contract', () => {
  test('classifies unverifiable legacy VK publications before owner identity is required', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const classification = sql.indexOf('UPDATE "publication"\nSET "state" = \'manual_review\'');
    const ownerConstraint = sql.indexOf(
      'ALTER TABLE "publication" ADD CONSTRAINT "publication_published_check"',
    );

    expect(classification).toBeGreaterThan(-1);
    expect(ownerConstraint).toBeGreaterThan(classification);
    expect(sql).toContain('VK_LEGACY_REMOTE_OWNER_UNVERIFIED');
    expect(sql).toContain('"platform" = \'vk\'');
    expect(sql).toContain('"state" = \'published\'');
    expect(sql).toContain('"remote_owner_id" IS NULL');
    expect(sql).not.toMatch(/SET\s+"remote_owner_id"\s*=/);
  });

  test('does not rewrite VK user identity or encrypted publishing credentials', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).not.toMatch(/(?:UPDATE|ALTER TABLE)\s+"publishing_account"/i);
    expect(sql).not.toMatch(/provider_account_id/i);
    expect(sql).not.toMatch(/(?:access|refresh)_token_ciphertext/i);
    expect(sql).not.toMatch(/credential_(?:key_id|format_version|revision)/i);
  });

  test('keeps the historical journal lineage unchanged', async () => {
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.find((entry) => entry.idx === 2)?.tag).toBe('0002_ancient_bloodstrike');
    expect(journal.entries.some((entry) => entry.idx > 2)).toBe(true);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });
});
