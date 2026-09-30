import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { failure, success } from '../../result';
import { at, dayOf } from '../../testing/civil-time';
import { END_PROJECT_HOUR, MIN_PROJECT_HOUR } from '../../time';
import {
  createDateParser,
  createDateTimeFormatter,
  formatRegionalDateTime,
  parseCsvDate,
  type RegionalFormat,
} from './regional-format';

const FRENCH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const AMERICAN: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'monthDayYear',
  dateSeparator: '/',
  twelveHourClock: true,
};
const SWEDISH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'yearMonthDay',
  dateSeparator: '-',
  twelveHourClock: false,
};
const FORMATS = [FRENCH, AMERICAN, SWEDISH];

describe('formatRegionalDateTime', () => {
  it.each<[RegionalFormat, string]>([
    [FRENCH, '05/10/2026 09:00'],
    [AMERICAN, '10/05/2026 9:00 AM'],
    [SWEDISH, '2026-10-05 09:00'],
  ])('writes a date and hour in the regional order and clock', (format, expected) => {
    expect(formatRegionalDateTime(at(2026, 10, 5, 9), format)).toBe(expected);
  });

  it.each([
    [0, '12:00 AM'],
    [12, '12:00 PM'],
    [13, '1:00 PM'],
    [23, '11:00 PM'],
  ])('writes the hour %i on a 12-hour clock as %s', (hour, expected) => {
    expect(formatRegionalDateTime(at(2026, 1, 2, hour), AMERICAN)).toBe(`01/02/2026 ${expected}`);
  });
});

describe('parseCsvDate', () => {
  it('reads back every hour it writes, in every format', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 1 }),
        fc.constantFrom(...FORMATS),
        (hour, format) => {
          expect(parseCsvDate(formatRegionalDateTime(hour, format), format)).toEqual(
            success({ kind: 'dateTime', hour }),
          );
        },
      ),
    );
  });

  it.each<[string, RegionalFormat]>([
    ['2026-10-05 14:00', FRENCH],
    ['2026-10-05T14:00', AMERICAN],
    ['2026-10-05 14:00:00', FRENCH],
    ['5/10/2026 14:00', FRENCH],
    ['05.10.2026 14:00', FRENCH],
    ['10/5/2026 2:00 PM', AMERICAN],
    ['10/5/26 2:00 pm', AMERICAN],
    ['2026/10/05 14:00', SWEDISH],
    ['  05/10/2026 14:00  ', FRENCH],
  ])('reads %j', (text, format) => {
    expect(parseCsvDate(text, format)).toEqual(
      success({ kind: 'dateTime', hour: at(2026, 10, 5, 14) }),
    );
  });

  it('reads a date without hour as a whole day', () => {
    expect(parseCsvDate('05/10/2026', FRENCH)).toEqual(
      success({ kind: 'date', day: dayOf(2026, 10, 5) }),
    );
    expect(parseCsvDate('2026-10-05', AMERICAN)).toEqual(
      success({ kind: 'date', day: dayOf(2026, 10, 5) }),
    );
  });

  it.each([
    '05/10/2026 14:10',
    '05/10/2026 14:00:30',
    '31/02/2026',
    '05/13/2026',
    '05/10/2019',
    '05/10/2201',
    '05/10/2026 24:00',
    '05/10/2026 13:00 PM',
    '05/10/2026 0:00 AM',
    'tomorrow',
    '2026-10',
    '',
    `05/10/2026${' '.repeat(100)}1`,
  ])('refuses %j', (text) => {
    expect(parseCsvDate(text, FRENCH)).toEqual(failure('INVALID_DATE'));
  });

  it('places a two-digit year in the century Excel uses, refusing years before 2020', () => {
    expect(parseCsvDate('10/5/29', AMERICAN)).toEqual(
      success({ kind: 'date', day: dayOf(2029, 10, 5) }),
    );
    expect(parseCsvDate('10/5/99', AMERICAN)).toEqual(failure('INVALID_DATE'));
  });

  it.each(['2026-10-05T14:00:00Z', '2026-10-05T14:00+02:00'])(
    'refuses the date %j, which carries a time zone the project does not use',
    (text) => {
      expect(parseCsvDate(text, FRENCH)).toEqual(failure('INVALID_DATE'));
    },
  );

  it('reads the regional order, so that the same text means different days', () => {
    expect(parseCsvDate('01/02/2026', FRENCH)).toEqual(
      success({ kind: 'date', day: dayOf(2026, 2, 1) }),
    );
    expect(parseCsvDate('01/02/2026', AMERICAN)).toEqual(
      success({ kind: 'date', day: dayOf(2026, 1, 2) }),
    );
  });

  it('refuses a text too long to be a date before running any pattern', () => {
    expect(parseCsvDate(`2026-10-05${' '.repeat(1_000_000)}x`, FRENCH)).toEqual(
      failure('INVALID_DATE'),
    );
  });
});

describe('cached date reading and writing', () => {
  it('writes and reads exactly as the direct functions, repeated values included', () => {
    const hourArbitrary = fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 1 });
    const writtenDate = fc
      .tuple(hourArbitrary, fc.constantFrom(...FORMATS), fc.boolean())
      .map(([hour, format, withHour]) => {
        const text = formatRegionalDateTime(hour, format);
        return withHour ? text : text.slice(0, text.indexOf(' '));
      });
    const text = fc.oneof(
      writtenDate,
      fc.constantFrom('2026-10-05', '2026-10-05 14:00', 'x', '31/02/2026', ' '.repeat(80)),
    );
    fc.assert(
      fc.property(
        fc.array(hourArbitrary, { maxLength: 20 }),
        fc.array(text, { maxLength: 20 }),
        fc.constantFrom(...FORMATS),
        (hours, texts, format) => {
          const formatDateTime = createDateTimeFormatter(format);
          const parseDate = createDateParser(format);
          [...hours, ...hours].forEach((hour) => {
            expect(formatDateTime(hour)).toBe(formatRegionalDateTime(hour, format));
          });
          [...texts, ...texts].forEach((written) => {
            expect(parseDate(written)).toEqual(parseCsvDate(written, format));
          });
        },
      ),
    );
  });
});
