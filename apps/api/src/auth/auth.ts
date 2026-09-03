import { createDatabase } from '@sovara-studio/db';
import { AUTH_SECRET, APP_ORIGIN, DATABASE_URL } from '../env.js';
import { createAuth } from './options.js';

const database = createDatabase(DATABASE_URL);
export const auth = createAuth(database, { secret: AUTH_SECRET, appOrigin: APP_ORIGIN });
export { database };
