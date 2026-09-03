import { describe, expect, test } from 'vitest';
import { calculatePartRange } from './part-ranges';

describe('calculatePartRange', () => {
  test('calculates exact and short final parts', () => {
    expect(calculatePartRange(10, 5, 2, 1)).toEqual({ partNumber: 1, start: 0, end: 5, size: 5 });
    expect(calculatePartRange(11, 5, 3, 3)).toEqual({ partNumber: 3, start: 10, end: 11, size: 1 });
  });

  test('supports safe tens-of-GB arithmetic', () => {
    const size = 50 * 1024 ** 3;
    const part = calculatePartRange(size, 64 * 1024 ** 2, 800, 800);
    expect(part.end).toBe(size);
    expect(part.size).toBe(64 * 1024 ** 2);
  });

  test('rejects unsafe and out-of-range plans', () => {
    expect(() => calculatePartRange(Number.MAX_SAFE_INTEGER + 1, 5, 1, 1)).toThrow();
    expect(() => calculatePartRange(10, 5, 2, 3)).toThrow();
  });
});
