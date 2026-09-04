import { expect, test } from 'vitest';
import { vkMetadataLinkForSave } from './publication-form';

test('maps blank-only VK metadata links to a persisted clear', () => {
  expect(vkMetadataLinkForSave('  ')).toBeNull();
});
