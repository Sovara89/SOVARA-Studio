import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const assetsDir = join(process.cwd(), 'apps', 'web', 'dist', 'assets');
const assets = (await readdir(assetsDir)).filter((name) => name.endsWith('.js'));
const smokeAsset = assets.find((name) => name.startsWith('bundle-smoke-'));
if (!smokeAsset) throw new Error('Built web bundle has no bundle-smoke JavaScript asset');

const smokeModule = await import(pathToFileURL(join(assetsDir, smokeAsset)).href);
if (typeof smokeModule.runBundleSmoke !== 'function')
  throw new Error('Built bundle-smoke module has no executable smoke entry');

const parsed = await smokeModule.runBundleSmoke();
if (parsed.videoId !== '00000000-0000-4000-8000-000000000001')
  throw new Error('Built uploader API did not parse the representative status response');
if (parsed.parts.length !== 1 || parsed.parts[0].partNumber !== 1)
  throw new Error('Built uploader API returned an unexpected parsed parts payload');

console.log(`Web bundle smoke: PASS (executed dist/${smokeAsset}, parsed upload status)`);
