import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REGIONAL_FORMAT, regionalFormatOf } from './system-regional-format';

describe('regionalFormatOf', () => {
  it.each([
    [
      'fr-FR',
      { listSeparator: ';', dateOrder: 'dayMonthYear', dateSeparator: '/', twelveHourClock: false },
    ],
    [
      'en-US',
      { listSeparator: ',', dateOrder: 'monthDayYear', dateSeparator: '/', twelveHourClock: true },
    ],
    [
      'de-DE',
      { listSeparator: ';', dateOrder: 'dayMonthYear', dateSeparator: '.', twelveHourClock: false },
    ],
    [
      'en-GB',
      { listSeparator: ',', dateOrder: 'dayMonthYear', dateSeparator: '/', twelveHourClock: false },
    ],
    [
      'sv-SE',
      { listSeparator: ';', dateOrder: 'yearMonthDay', dateSeparator: '-', twelveHourClock: false },
    ],
  ] as const)('reads the format of %s', (locale, expected) => {
    expect(regionalFormatOf(locale)).toEqual(expected);
  });

  it('keeps the slash for a locale whose date separator carries a direction mark', () => {
    expect(regionalFormatOf('ar-EG')).toEqual({
      listSeparator: ',',
      dateOrder: 'dayMonthYear',
      dateSeparator: '/',
      twelveHourClock: true,
    });
  });

  it('writes ISO dates, with a warning, for short dates of an unfamiliar form, keeping the list separator and the clock', () => {
    const parts = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockReturnValue([{ type: 'era', value: 'AD' }]);
    const options = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({} as Intl.ResolvedDateTimeFormatOptions);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(regionalFormatOf('fr-FR')).toEqual({
        listSeparator: ';',
        dateOrder: 'yearMonthDay',
        dateSeparator: '-',
        twelveHourClock: false,
      });
      expect(warned.mock.calls).toEqual([
        [
          'The short dates of "fr-FR" are written "AD", which CSV files cannot follow: they use ISO dates.',
        ],
      ]);
    } finally {
      parts.mockRestore();
      options.mockRestore();
      warned.mockRestore();
    }
  });

  it('writes ISO dates, with a warning, for a date separator it does not know', () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
      { type: 'day', value: '05' },
      { type: 'literal', value: '~' },
      { type: 'month', value: '10' },
      { type: 'literal', value: '~' },
      { type: 'year', value: '2026' },
    ]);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(regionalFormatOf('en-GB')).toEqual({
        listSeparator: ',',
        dateOrder: 'yearMonthDay',
        dateSeparator: '-',
        twelveHourClock: false,
      });
      expect(warned.mock.calls).toEqual([
        [
          'The short dates of "en-GB" are written "05~10~2026", which CSV files cannot follow: they use ISO dates.',
        ],
      ]);
    } finally {
      parts.mockRestore();
      warned.mockRestore();
    }
  });

  it('lets an unexpected failure of the locale check through', () => {
    const check = vi.spyOn(Intl, 'getCanonicalLocales').mockImplementation(() => {
      throw new TypeError('broken');
    });
    try {
      expect(() => regionalFormatOf('fr-FR')).toThrow('broken');
    } finally {
      check.mockRestore();
    }
  });

  it.each(['', 'not a locale', '12345'])(
    'falls back to the default format for %j, with a warning',
    (locale) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(regionalFormatOf(locale)).toEqual(DEFAULT_REGIONAL_FORMAT);
        expect(warned.mock.calls).toEqual([
          [`Unknown locale ${JSON.stringify(locale)}: CSV files use the ISO format.`],
        ]);
      } finally {
        warned.mockRestore();
      }
    },
  );
});
