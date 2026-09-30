export const DEFAULT_TABLE_WIDTH = 560;
export const MIN_TABLE_WIDTH = 240;
export const MIN_TIMELINE_WIDTH = 200;
export const TABLE_WIDTH_STEP = 16;

const STORAGE_KEY = 'tasklace.taskTableWidth';

export interface WidthStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

/** Keeps a table width between its minimum and the width that leaves room for the timeline. */
export function clampTableWidth(width: number, containerWidth: number): number {
  const maximum = Math.max(MIN_TABLE_WIDTH, containerWidth - MIN_TIMELINE_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_TABLE_WIDTH), maximum));
}

/** Reads the table width remembered on this computer, or the default width when none can be read. */
export function readTableWidth(store: WidthStore | null): number {
  try {
    const stored = Number(store?.getItem(STORAGE_KEY) ?? Number.NaN);
    return Number.isFinite(stored) && stored >= MIN_TABLE_WIDTH ? stored : DEFAULT_TABLE_WIDTH;
  } catch {
    return DEFAULT_TABLE_WIDTH;
  }
}

/** Remembers the table width on this computer, doing nothing when the browser storage refuses it. */
export function rememberTableWidth(store: WidthStore | null, width: number): void {
  try {
    store?.setItem(STORAGE_KEY, String(width));
  } catch {
    return;
  }
}
