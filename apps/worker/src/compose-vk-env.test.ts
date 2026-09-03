import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { describe, expect, test } from 'vitest';
import { parseWorkerEnvironment } from './env.js';

function serviceBlock(compose: string, service: string, nextService: string) {
  const start = compose.indexOf(`  ${service}:`);
  const end = compose.indexOf(`  ${nextService}:`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Compose service block not found: ${service}`);
  return compose.slice(start, end);
}

describe('VK Compose environment contract', () => {
  test('forwards only existing VK OAuth names to API and worker without embedding credentials', async () => {
    const compose = await readFile(new URL('../../../compose.yaml', import.meta.url), 'utf8');
    const names = ['VK_CLIENT_ID', 'VK_SERVICE_TOKEN', 'VK_REDIRECT_URI'];
    for (const block of [
      serviceBlock(compose, 'api', 'worker'),
      serviceBlock(compose, 'worker', 'web'),
    ]) {
      for (const name of names) expect(block).toMatch(new RegExp(`\\n      ${name}:\\r?\\n`));
      const configured = [
        ...block.matchAll(/^      (VK_(?:CLIENT_ID|SERVICE_TOKEN|REDIRECT_URI)):/gm),
      ]
        .map((match) => match[1])
        .sort();
      expect(configured).toEqual([...names].sort());
      expect(block).not.toContain('user-access-token');
    }
  });

  test('keeps example VK publication disabled as an absent, parser-valid Compose configuration', async () => {
    const [compose, example] = await Promise.all([
      readFile(new URL('../../../compose.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../../../.env.example', import.meta.url), 'utf8'),
    ]);
    const parsedExample = parseEnv(example);
    const vkNames = ['VK_CLIENT_ID', 'VK_SERVICE_TOKEN', 'VK_REDIRECT_URI', 'VK_GROUP_ID'];

    expect(Object.fromEntries(vkNames.map((name) => [name, parsedExample[name]]))).toEqual({
      VK_CLIENT_ID: undefined,
      VK_SERVICE_TOKEN: undefined,
      VK_REDIRECT_URI: undefined,
      VK_GROUP_ID: undefined,
    });
    const composeForwardedVK = Object.fromEntries(
      vkNames.map((name) => [name, parsedExample[name]]),
    );
    expect(parseWorkerEnvironment(composeForwardedVK)).toMatchObject({
      VK_CLIENT_ID: undefined,
      VK_SERVICE_TOKEN: undefined,
      VK_REDIRECT_URI: undefined,
      VK_GROUP_ID: undefined,
    });
    const worker = serviceBlock(compose, 'worker', 'web');
    for (const name of vkNames) expect(worker).toMatch(new RegExp(`\\n      ${name}:\\r?\\n`));
  });
});
