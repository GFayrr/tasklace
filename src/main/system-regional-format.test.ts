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

  it('falls back to the default order, the slash and a 24-hour clock for an unfamiliar date format', () => {
    const parts = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockReturnValue([{ type: 'era', value: 'AD' }]);
    const options = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({} as Intl.ResolvedDateTimeFormatOptions);
    try {
      expect(regionalFormatOf('en-US')).toEqual({
        listSeparator: ',',
        dateOrder: DEFAULT_REGIONAL_FORMAT.dateOrder,
        dateSeparator: '/',
        twelveHourClock: false,
      });
    } finally {
      parts.mockRestore();
      options.mockRestore();
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

  it.each(['', 'not a locale', '12345'])('falls back to the default format for %j', (locale) => {
    expect(regionalFormatOf(locale)).toEqual(DEFAULT_REGIONAL_FORMAT);
  });
});
