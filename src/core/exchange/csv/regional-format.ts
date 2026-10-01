import { failure, success, type Result } from '../../result';
import {
  dayIndexOf,
  fromProjectHour,
  toProjectHour,
  type DayIndex,
  type ProjectHour,
} from '../../time';
import type { CsvSeparator } from './csv-text';

export type DateOrder = 'dayMonthYear' | 'monthDayYear' | 'yearMonthDay';

export type DateSeparator = '/' | '.' | '-';

export interface RegionalFormat {
  readonly listSeparator: CsvSeparator;
  readonly dateOrder: DateOrder;
  readonly dateSeparator: DateSeparator;
  readonly twelveHourClock: boolean;
}

export type DateParser = (text: string) => Result<CsvDate, 'INVALID_DATE'>;

export type DateTimeFormatter = (hour: ProjectHour) => string;

export type CsvDate =
  | { readonly kind: 'dateTime'; readonly hour: ProjectHour }
  | { readonly kind: 'date'; readonly day: DayIndex };

interface DateTexts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
}

interface TimeTexts {
  readonly hour: string | undefined;
  readonly minute: string | undefined;
  readonly second: string | undefined;
  readonly halfDay: string | undefined;
}

const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const REGIONAL_PATTERN =
  /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const DECIMAL_RADIX = 10;
const MAX_DATE_LENGTH = 64;
const TWO_DIGITS = 2;
const FOUR_DIGITS = 4;
const SHORT_YEAR_CENTURY = 2000;
const PREVIOUS_CENTURY = 1900;
const SHORT_YEAR_PIVOT = 30;
const HALF_DAY_HOURS = 12;
const AFTERNOON_MARK = 'p';
const MORNING = 'AM';
const AFTERNOON = 'PM';

/** Returns the decimal mark of a region: a comma where the list separator is a semicolon, a dot otherwise. */
export function decimalMarkOf(format: RegionalFormat): string {
  return format.listSeparator === ';' ? ',' : '.';
}

/** Writes a project hour as a date and an hour in the regional format, which spreadsheets read as a real date. */
export function formatRegionalDateTime(hour: ProjectHour, format: RegionalFormat): string {
  const civil = fromProjectHour(hour);
  const year = pad(civil.year, FOUR_DIGITS);
  const month = pad(civil.month, TWO_DIGITS);
  const day = pad(civil.day, TWO_DIGITS);
  const parts = {
    dayMonthYear: [day, month, year],
    monthDayYear: [month, day, year],
    yearMonthDay: [year, month, day],
  }[format.dateOrder];
  const time = formatTime(civil.hour, civil.minute, format.twelveHourClock);
  return `${parts.join(format.dateSeparator)} ${time}`;
}

/** Returns a function writing project hours in the regional format, each distinct hour being formatted only once. */
export function createDateTimeFormatter(format: RegionalFormat): DateTimeFormatter {
  const formatted = new Map<ProjectHour, string>();
  return (hour) => {
    const known = formatted.get(hour);
    if (known !== undefined) {
      return known;
    }
    const text = formatRegionalDateTime(hour, format);
    formatted.set(hour, text);
    return text;
  };
}

/** Returns a function reading dates like parseCsvDate, each distinct text short enough to be a date being read only once. */
export function createDateParser(format: RegionalFormat): DateParser {
  const parsed = new Map<string, Result<CsvDate, 'INVALID_DATE'>>();
  return (text) => {
    const known = parsed.get(text);
    if (known !== undefined) {
      return known;
    }
    const result = parseCsvDate(text, format);
    if (text.length <= MAX_DATE_LENGTH) {
      parsed.set(text, result);
    }
    return result;
  };
}

/** Reads a date, with or without a time, in ISO form or in the regional date order with any of "/", "." or "-", refusing a time that is not a whole quarter hour. */
export function parseCsvDate(
  text: string,
  format: RegionalFormat,
): Result<CsvDate, 'INVALID_DATE'> {
  const trimmed = text.trim();
  if (trimmed.length > MAX_DATE_LENGTH) {
    return failure('INVALID_DATE');
  }
  const iso = ISO_PATTERN.exec(trimmed);
  if (iso !== null) {
    const [, year = '', month = '', day = '', hour, minute, second] = iso;
    return buildDate({ year, month, day }, { hour, minute, second, halfDay: undefined });
  }
  const regional = REGIONAL_PATTERN.exec(trimmed);
  if (regional === null) {
    return failure('INVALID_DATE');
  }
  const [, first = '', second = '', third = '', hour, minute, seconds, halfDay] = regional;
  const time = { hour, minute, second: seconds, halfDay };
  return buildDate(orderDate(first, second, third, format.dateOrder), time);
}

/** Names the three numbers of a regional date according to the order of the region. */
function orderDate(first: string, second: string, third: string, order: DateOrder): DateTexts {
  if (order === 'dayMonthYear') {
    return { year: third, month: second, day: first };
  }
  return order === 'monthDayYear'
    ? { year: third, month: first, day: second }
    : { year: first, month: second, day: third };
}

/** Builds a date, or a date and hour when a time is given, from the texts of its parts. */
function buildDate(date: DateTexts, time: TimeTexts): Result<CsvDate, 'INVALID_DATE'> {
  if (toNumber(time.second) !== 0) {
    return failure('INVALID_DATE');
  }
  const hour = time.hour === undefined ? 0 : toDayHour(toNumber(time.hour), time.halfDay);
  if (hour === null) {
    return failure('INVALID_DATE');
  }
  const converted = toProjectHour({
    year: fullYear(date.year),
    month: toNumber(date.month),
    day: toNumber(date.day),
    hour,
    minute: toNumber(time.minute),
  });
  if (!converted.ok) {
    return failure('INVALID_DATE');
  }
  return success(
    time.hour === undefined
      ? { kind: 'date', day: dayIndexOf(converted.value) }
      : { kind: 'dateTime', hour: converted.value },
  );
}

/** Reads a year, a one- or two-digit year being placed in the century Excel uses: below 30 in the 2000s, from 30 in the 1900s. */
function fullYear(text: string): number {
  const year = toNumber(text);
  if (text.length > TWO_DIGITS) {
    return year;
  }
  return year + (year < SHORT_YEAR_PIVOT ? SHORT_YEAR_CENTURY : PREVIOUS_CENTURY);
}

/** Converts an hour of a 24-hour or 12-hour clock into an hour of the day, or null for a 12-hour clock hour outside 1 to 12. */
function toDayHour(hour: number, halfDay: string | undefined): number | null {
  if (halfDay === undefined) {
    return hour;
  }
  if (hour < 1 || hour > HALF_DAY_HOURS) {
    return null;
  }
  const isAfternoon = halfDay.toLowerCase().startsWith(AFTERNOON_MARK);
  return (hour % HALF_DAY_HOURS) + (isAfternoon ? HALF_DAY_HOURS : 0);
}

/** Writes a time of day on a 24-hour clock, or on a 12-hour clock with its half-day mark. */
function formatTime(hour: number, minute: number, twelveHourClock: boolean): string {
  const minutes = pad(minute, TWO_DIGITS);
  if (!twelveHourClock) {
    return `${pad(hour, TWO_DIGITS)}:${minutes}`;
  }
  const clockHour = hour % HALF_DAY_HOURS === 0 ? HALF_DAY_HOURS : hour % HALF_DAY_HOURS;
  return `${String(clockHour)}:${minutes} ${hour < HALF_DAY_HOURS ? MORNING : AFTERNOON}`;
}

/** Converts decimal digits into a number, a missing part counting as zero. */
function toNumber(text: string | undefined): number {
  return text === undefined ? 0 : Number.parseInt(text, DECIMAL_RADIX);
}

/** Writes a whole number with leading zeros up to a given width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
