import { stdin, stdout } from 'node:process';
import {
  createDatabase,
  findCredentialAccount,
  findSessionsForUser,
  findUserByEmail,
} from '@sovara-studio/db';
import { AUTH_SECRET, APP_ORIGIN, DATABASE_URL } from '../env.js';
import { createAuth } from '../auth/options.js';

function valueArgument(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readHidden(prompt: string) {
  if (!stdin.isTTY || !stdin.setRawMode)
    throw new Error('Interactive provisioning requires a TTY; use --password-stdin for automation');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Provisioning interrupted'));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinPassword() {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trimEnd();
}

const args = process.argv.slice(2);
if (args.includes('--password'))
  throw new Error('Passwords must not be passed as command arguments');
const email = valueArgument(args, '--email');
const name = valueArgument(args, '--name');
if (!email || !name)
  throw new Error('Usage: pnpm user:provision -- --email <email> --name <name> [--password-stdin]');

const password = args.includes('--password-stdin')
  ? await readStdinPassword()
  : await readHidden('Password: ');
if (!args.includes('--password-stdin')) {
  const confirmation = await readHidden('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
}
const database = createDatabase(DATABASE_URL);
try {
  const existing = await findUserByEmail(database.db, email.toLowerCase());
  if (existing.length > 0) throw new Error('User already exists');
  const auth = createAuth(database, {
    secret: AUTH_SECRET,
    appOrigin: APP_ORIGIN,
    provisioning: true,
  });
  const result = await auth.api.signUpEmail({ body: { email, name, password } });
  if (!result?.user) throw new Error('Provisioning did not create a user');
  const createdAccount = await findCredentialAccount(database.db, result.user.id);
  if (createdAccount.length !== 1)
    throw new Error('Provisioning did not create a credential account');
  const createdSessions = await findSessionsForUser(database.db, result.user.id);
  if (createdSessions.length !== 0) throw new Error('Provisioning unexpectedly created a session');
  console.log(`Provisioned user ${result.user.id} (${result.user.email})`);
} finally {
  await database.pool.end();
}
