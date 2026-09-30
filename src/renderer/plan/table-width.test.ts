import { describe, expect, it } from 'vitest';
import {
  clampTableWidth,
  DEFAULT_TABLE_WIDTH,
  MIN_TABLE_WIDTH,
  readTableWidth,
  rememberTableWidth,
  type WidthStore,
} from './table-width';

/** A storage kept in memory. */
function memoryStore(): WidthStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const BROKEN: WidthStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('table width', () => {
  it('stays between its minimum and the room the timeline needs', () => {
    expect(clampTableWidth(10, 1_000)).toBe(MIN_TABLE_WIDTH);
    expect(clampTableWidth(950, 1_000)).toBe(800);
    expect(clampTableWidth(500.4, 1_000)).toBe(500);
    expect(clampTableWidth(500, 300)).toBe(MIN_TABLE_WIDTH);
  });

  it('is remembered on this computer, and falls back to the default when storage fails', () => {
    const store = memoryStore();
    expect(readTableWidth(store)).toBe(DEFAULT_TABLE_WIDTH);
    rememberTableWidth(store, 420);
    expect(readTableWidth(store)).toBe(420);
    store.setItem('tasklace.taskTableWidth', 'wide');
    expect(readTableWidth(store)).toBe(DEFAULT_TABLE_WIDTH);
    expect(readTableWidth(BROKEN)).toBe(DEFAULT_TABLE_WIDTH);
    expect(() => {
      rememberTableWidth(BROKEN, 400);
    }).not.toThrow();
    expect(readTableWidth(null)).toBe(DEFAULT_TABLE_WIDTH);
  });
});
