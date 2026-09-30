import { describe, expect, it } from 'vitest';
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

  it.each(['', 'not a locale', '12345'])('falls back to the default format for %j', (locale) => {
    expect(regionalFormatOf(locale)).toEqual(DEFAULT_REGIONAL_FORMAT);
  });
});
