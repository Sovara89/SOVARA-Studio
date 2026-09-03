import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

function serviceBlock(compose: string, service: string, nextService: string) {
  const start = compose.indexOf(`  ${service}:`);
  const end = compose.indexOf(`  ${nextService}:`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Compose service block not found: ${service}`);
  return compose.slice(start, end);
}

describe('YouTube Compose environment contract', () => {
  test('forwards only the existing OAuth schema names without embedding values', async () => {
    const compose = await readFile(new URL('../../../compose.yaml', import.meta.url), 'utf8');
    const api = serviceBlock(compose, 'api', 'worker');
    const worker = serviceBlock(compose, 'worker', 'web');
    const names = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'];

    for (const block of [api, worker]) {
      for (const name of names) expect(block).toMatch(new RegExp(`\\n      ${name}:\\r?\\n`));
      const oauthNames = [
        ...block.matchAll(/^      (YOUTUBE_(?:CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)):/gm),
      ]
        .map((match) => match[1])
        .sort();
      expect(oauthNames).toEqual([...names].sort());
    }
  });
});
