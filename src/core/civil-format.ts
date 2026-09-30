import { failure, success, type Result } from './result';
import {
  dayIndexOf,
  fromProjectHour,
  startOfDay,
  toProjectHour,
  type DayIndex,
  type ProjectHour,
} from './time';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DECIMAL_RADIX = 10;
const TWO_DIGITS = 2;
const FOUR_DIGITS = 4;
const DATE_TIME_DATE_LENGTH = 10;

/** Writes a project hour as "YYYY-MM-DDTHH:MM", a wall-clock time without time zone. */
export function formatDateTime(hour: ProjectHour): string {
  const { year, month, day, hour: hourOfDay, minute } = fromProjectHour(hour);
  const date = `${pad(year, FOUR_DIGITS)}-${pad(month, TWO_DIGITS)}-${pad(day, TWO_DIGITS)}`;
  return `${date}T${pad(hourOfDay, TWO_DIGITS)}:${pad(minute, TWO_DIGITS)}`;
}

/** Writes a day as "YYYY-MM-DD". */
export function formatDate(day: DayIndex): string {
  return formatDateTime(startOfDay(day)).slice(0, DATE_TIME_DATE_LENGTH);
}

/** Reads a "YYYY-MM-DDTHH:MM" text into a project hour, rejecting impossible dates, times that are not a whole quarter hour and years outside the project range. */
export function parseDateTime(text: string): Result<ProjectHour, 'INVALID_DATE_TIME'> {
  const match = DATE_TIME_PATTERN.exec(text);
  if (match === null) {
    return failure('INVALID_DATE_TIME');
  }
  const [year, month, day, hour, minute] = match
    .slice(1)
    .map((part) => Number.parseInt(part, DECIMAL_RADIX));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return failure('INVALID_DATE_TIME');
  }
  return toProjectHour({ year, month, day, hour, minute });
}

/** Reads a "YYYY-MM-DD" text into a day, rejecting impossible dates and years outside the project range. */
export function parseDate(text: string): Result<DayIndex, 'INVALID_DATE_TIME'> {
  if (!DATE_PATTERN.test(text)) {
    return failure('INVALID_DATE_TIME');
  }
  const hour = parseDateTime(`${text}T00:00`);
  return hour.ok ? success(dayIndexOf(hour.value)) : hour;
}

/** Writes a whole number with leading zeros up to a given width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
