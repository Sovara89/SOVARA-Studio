import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'sovara-auth-schema-'));
const generated = join(temp, 'auth.generated.ts');
try {
  const config = join(root, 'scripts', 'better-auth-schema-config.mjs');
  const command = `pnpm exec auth generate --config ${JSON.stringify(config)} --output ${JSON.stringify(generated)} --adapter drizzle --dialect postgresql --yes`;
  await execAsync(command, {
    cwd: root,
    env: {
      ...process.env,
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'schema-check-only-secret-32-bytes-long',
    },
  });
  const expected = await readFile(
    join(root, 'packages', 'db', 'src', 'schema', 'auth.generated.ts'),
    'utf8',
  );
  const actual = await readFile(generated, 'utf8');
  const canonical = (value) =>
    value
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/["']/g, '"')
      .replace(/\s+/g, '')
      .replace(/,([)\]}])/g, '$1');
  if (canonical(actual) !== canonical(expected)) {
    console.error(
      'Better Auth generated schema differs from packages/db/src/schema/auth.generated.ts',
    );
    process.exitCode = 1;
  } else {
    console.log('Better Auth 1.7.2 Drizzle schema compatibility: PASS');
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
