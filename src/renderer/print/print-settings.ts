import { PAPER_NAMES, PAPER_ORIENTATIONS } from '../../core/print/paper';
import { MAX_DAY_INDEX, MIN_DAY_INDEX } from '../../core/time';
import type { WidthStore } from '../plan/table-width';
import { ZOOM_LEVELS } from '../plan/time-scale';
import {
  PRINT_COLUMNS,
  type PrintColumn,
  type PrintPeriod,
  type PrintSettings,
  type PrintZoomChoice,
} from './print-pages';

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paper: 'a4',
  orientation: 'landscape',
  period: { kind: 'whole' },
  zoom: 'automatic',
  columns: [],
};

const STORAGE_PREFIX = 'tasklace.printSettings.';
const ZOOM_CHOICES: readonly PrintZoomChoice[] = ['automatic', ...ZOOM_LEVELS];
const SETTINGS_KEYS = ['paper', 'orientation', 'period', 'zoom', 'columns'];
const PERIOD_DAYS_KEYS = ['kind', 'firstDay', 'lastDay'];

/** Reads the print settings remembered on this computer for a project, which are not trusted, or the default settings when there are none or they cannot be read. */
export function readPrintSettings(store: WidthStore | null, documentId: string): PrintSettings {
  try {
    const text = store?.getItem(`${STORAGE_PREFIX}${documentId}`) ?? null;
    if (text === null) {
      return DEFAULT_PRINT_SETTINGS;
    }
    const settings = settingsOf(JSON.parse(text));
    if (settings === null) {
      console.warn('The remembered print settings of this project are damaged and were not used.');
      return DEFAULT_PRINT_SETTINGS;
    }
    return settings;
  } catch (error) {
    console.warn('The remembered print settings of this project could not be read:', error);
    return DEFAULT_PRINT_SETTINGS;
  }
}

/** Remembers the print settings of a project on this computer, outside the project file, doing nothing when the browser storage refuses them. */
export function rememberPrintSettings(
  store: WidthStore | null,
  documentId: string,
  settings: PrintSettings,
): void {
  try {
    store?.setItem(`${STORAGE_PREFIX}${documentId}`, JSON.stringify(settings));
  } catch (error) {
    console.warn('The print settings of this project could not be remembered:', error);
  }
}

/** Reads print settings from a parsed value, or returns null when any part of it is not as written by this application. */
function settingsOf(value: unknown): PrintSettings | null {
  if (!hasExactKeys(value, SETTINGS_KEYS)) {
    return null;
  }
  const { paper, orientation, period, zoom, columns } = value;
  const readPeriod = periodOf(period);
  const readColumns = columnsOf(columns);
  if (
    !PAPER_NAMES.some((name) => name === paper) ||
    !PAPER_ORIENTATIONS.some((name) => name === orientation) ||
    !ZOOM_CHOICES.some((choice) => choice === zoom) ||
    readPeriod === null ||
    readColumns === null
  ) {
    return null;
  }
  return {
    paper: paper as PrintSettings['paper'],
    orientation: orientation as PrintSettings['orientation'],
    period: readPeriod,
    zoom: zoom as PrintZoomChoice,
    columns: readColumns,
  };
}

/** Reads a printed period: the whole plan, or whole days within the years handled, the last not before the first. */
function periodOf(value: unknown): PrintPeriod | null {
  if (hasExactKeys(value, ['kind']) && value['kind'] === 'whole') {
    return { kind: 'whole' };
  }
  if (!hasExactKeys(value, PERIOD_DAYS_KEYS) || value['kind'] !== 'days') {
    return null;
  }
  const { firstDay, lastDay } = value;
  if (!isDay(firstDay) || !isDay(lastDay) || lastDay < firstDay) {
    return null;
  }
  return { kind: 'days', firstDay, lastDay };
}

/** Reads the chosen columns: known columns, each at most once. */
function columnsOf(value: unknown): PrintColumn[] | null {
  if (!Array.isArray(value) || value.length > PRINT_COLUMNS.length) {
    return null;
  }
  const columns: unknown[] = value;
  const known = columns.every((column) => PRINT_COLUMNS.some((name) => name === column));
  return known && new Set(columns).size === columns.length ? (columns as PrintColumn[]) : null;
}

/** Tells whether a value is a whole day within the years Tasklace handles. */
function isDay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_DAY_INDEX &&
    value <= MAX_DAY_INDEX
  );
}

/** Tells whether a value is a plain object holding exactly some keys. */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
