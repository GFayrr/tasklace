import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DAY_INDEX, MIN_DAY_INDEX } from '../../core/time';
import type { WidthStore } from '../plan/table-width';
import type { PrintSettings } from './print-pages';
import { DEFAULT_PRINT_SETTINGS, readPrintSettings, rememberPrintSettings } from './print-settings';

const DOCUMENT = '00000000-0000-4000-8000-000000000001';
const KEY = `tasklace.printSettings.${DOCUMENT}`;
const CHOSEN: PrintSettings = {
  paper: 'a3',
  orientation: 'portrait',
  period: { kind: 'days', firstDay: 20_700, lastDay: 20_730 },
  zoom: 'week',
  columns: ['wbs', 'floats'],
};

/** Creates a store in memory holding some entries. */
function storeWith(
  entries: Record<string, string> = {},
): WidthStore & { entries: Record<string, string> } {
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('print settings', () => {
  it('gives the default settings when nothing is remembered or there is no store', () => {
    expect(readPrintSettings(storeWith(), DOCUMENT)).toBe(DEFAULT_PRINT_SETTINGS);
    expect(readPrintSettings(null, DOCUMENT)).toBe(DEFAULT_PRINT_SETTINGS);
    expect(DEFAULT_PRINT_SETTINGS).toEqual({
      paper: 'a4',
      orientation: 'landscape',
      period: { kind: 'whole' },
      zoom: 'automatic',
      columns: [],
    });
  });

  it('remembers the settings of each project apart and reads them back', () => {
    const store = storeWith();
    rememberPrintSettings(store, DOCUMENT, CHOSEN);
    rememberPrintSettings(store, 'other', DEFAULT_PRINT_SETTINGS);
    expect(readPrintSettings(store, DOCUMENT)).toEqual(CHOSEN);
    expect(readPrintSettings(store, 'other')).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(Object.keys(store.entries)).toEqual([KEY, 'tasklace.printSettings.other']);
  });

  it('reads back days at the edges of the years handled', () => {
    const store = storeWith();
    const edges: PrintSettings = {
      ...CHOSEN,
      period: { kind: 'days', firstDay: MIN_DAY_INDEX, lastDay: MAX_DAY_INDEX },
    };
    rememberPrintSettings(store, DOCUMENT, edges);
    expect(readPrintSettings(store, DOCUMENT)).toEqual(edges);
  });

  it.each([
    ['text that is no JSON', '{'],
    ['a value that is no object', '[]'],
    ['a missing key', JSON.stringify({ ...CHOSEN, zoom: undefined })],
    ['an unknown key', JSON.stringify({ ...CHOSEN, scale: 2 })],
    ['an unknown paper', JSON.stringify({ ...CHOSEN, paper: 'a5' })],
    ['an unknown orientation', JSON.stringify({ ...CHOSEN, orientation: 'square' })],
    ['an unknown zoom', JSON.stringify({ ...CHOSEN, zoom: 'year' })],
    ['an unknown period', JSON.stringify({ ...CHOSEN, period: { kind: 'all' } })],
    [
      'days that end before they start',
      JSON.stringify({ ...CHOSEN, period: { kind: 'days', firstDay: 5, lastDay: 4 } }),
    ],
    [
      'a day that is no whole number',
      JSON.stringify({ ...CHOSEN, period: { kind: 'days', firstDay: 20_700.5, lastDay: 20_730 } }),
    ],
    [
      'a day before the years handled',
      JSON.stringify({
        ...CHOSEN,
        period: { kind: 'days', firstDay: MIN_DAY_INDEX - 1, lastDay: 20_730 },
      }),
    ],
    [
      'a day after the years handled',
      JSON.stringify({
        ...CHOSEN,
        period: { kind: 'days', firstDay: 20_700, lastDay: MAX_DAY_INDEX + 1 },
      }),
    ],
    [
      'a period with another key',
      JSON.stringify({ ...CHOSEN, period: { kind: 'whole', firstDay: 1 } }),
    ],
    ['columns that are no list', JSON.stringify({ ...CHOSEN, columns: 'wbs' })],
    ['an unknown column', JSON.stringify({ ...CHOSEN, columns: ['tag'] })],
    ['a column twice', JSON.stringify({ ...CHOSEN, columns: ['wbs', 'wbs'] })],
    [
      'too many columns',
      JSON.stringify({
        ...CHOSEN,
        columns: ['wbs', 'start', 'end', 'duration', 'progress', 'predecessors', 'floats', 'wbs'],
      }),
    ],
  ])('falls back to the default settings on %s, and says so in the log', (_name, text) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readPrintSettings(storeWith({ [KEY]: text }), DOCUMENT)).toBe(DEFAULT_PRINT_SETTINGS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says in the log that settings could not be read or remembered when the store refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refusal = new Error('Storage refused');
    const store: WidthStore = {
      getItem: () => {
        throw refusal;
      },
      setItem: () => {
        throw refusal;
      },
    };
    expect(readPrintSettings(store, DOCUMENT)).toBe(DEFAULT_PRINT_SETTINGS);
    rememberPrintSettings(store, DOCUMENT, CHOSEN);
    expect(warn.mock.calls).toEqual([
      ['The remembered print settings of this project could not be read:', refusal],
      ['The print settings of this project could not be remembered:', refusal],
    ]);
  });

  it('says exactly why damaged settings were not used', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    readPrintSettings(storeWith({ [KEY]: '{}' }), DOCUMENT);
    expect(warn.mock.calls).toEqual([
      ['The remembered print settings of this project are damaged and were not used.'],
    ]);
  });
});
