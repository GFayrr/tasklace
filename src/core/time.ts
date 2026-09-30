import { MAX_PROJECT_YEAR, MIN_PROJECT_YEAR } from './limits';
import { failure, success, type Result } from './result';

export type ProjectHour = number;
export type DayIndex = number;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CivilDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute?: number;
}

export const SUNDAY: Weekday = 0;
export const MONDAY: Weekday = 1;
export const TUESDAY: Weekday = 2;
export const WEDNESDAY: Weekday = 3;
export const THURSDAY: Weekday = 4;
export const FRIDAY: Weekday = 5;
export const SATURDAY: Weekday = 6;
export const WEEKDAYS: readonly Weekday[] = [
  SUNDAY,
  MONDAY,
  TUESDAY,
  WEDNESDAY,
  THURSDAY,
  FRIDAY,
  SATURDAY,
];

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const QUARTERS_PER_HOUR = 4;
export const QUARTER_HOUR = 1 / QUARTERS_PER_HOUR;
export const QUARTERS_PER_DAY = HOURS_PER_DAY * QUARTERS_PER_HOUR;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_QUARTER = MINUTES_PER_HOUR / QUARTERS_PER_HOUR;

const MILLISECONDS_PER_HOUR = 3_600_000;
const EPOCH_WEEKDAY = THURSDAY;
const JANUARY_INDEX = 0;
const FIRST_MONTH = 1;
const LAST_MONTH = 12;
const FIRST_DAY_OF_MONTH = 1;

export const MIN_PROJECT_HOUR: ProjectHour =
  Date.UTC(MIN_PROJECT_YEAR, JANUARY_INDEX, FIRST_DAY_OF_MONTH) / MILLISECONDS_PER_HOUR;
export const END_PROJECT_HOUR: ProjectHour =
  Date.UTC(MAX_PROJECT_YEAR + 1, JANUARY_INDEX, FIRST_DAY_OF_MONTH) / MILLISECONDS_PER_HOUR;
export const MIN_DAY_INDEX: DayIndex = MIN_PROJECT_HOUR / HOURS_PER_DAY;
export const MAX_DAY_INDEX: DayIndex = END_PROJECT_HOUR / HOURS_PER_DAY - 1;

/** Tells whether a number of hours is a whole number of quarter hours, the precision of every time and duration. */
export function isQuarterHours(value: number): boolean {
  return Number.isInteger(value * QUARTERS_PER_HOUR);
}

/** Counts the quarter hours in a number of hours made of whole quarter hours. */
export function toQuarters(hours: number): number {
  return Math.round(hours * QUARTERS_PER_HOUR);
}

/** Converts a count of quarter hours into hours. */
export function fromQuarters(quarters: number): number {
  return quarters / QUARTERS_PER_HOUR;
}

/** Tells whether a value is a quarter hour inside the supported project period. */
export function isProjectHour(value: number): boolean {
  return isQuarterHours(value) && value >= MIN_PROJECT_HOUR && value < END_PROJECT_HOUR;
}

/** Converts a wall-clock date and hour, without time zone, into a project hour. */
export function toProjectHour(dateTime: CivilDateTime): Result<ProjectHour, 'INVALID_DATE_TIME'> {
  if (!hasValidDateTimeFields(dateTime)) {
    return failure('INVALID_DATE_TIME');
  }
  const { year, month, day, hour, minute = 0 } = dateTime;
  const date = new Date(Date.UTC(year, month - FIRST_MONTH, day, hour, minute));
  if (date.getUTCMonth() !== month - FIRST_MONTH || date.getUTCDate() !== day) {
    return failure('INVALID_DATE_TIME');
  }
  return success(date.getTime() / MILLISECONDS_PER_HOUR);
}

/** Checks the ranges of each date, hour and minute field before any conversion, minutes being a whole quarter hour. */
function hasValidDateTimeFields({ year, month, day, hour, minute = 0 }: CivilDateTime): boolean {
  const allIntegers = [year, month, day, hour, minute].every((field) => Number.isInteger(field));
  return (
    allIntegers &&
    minute >= 0 &&
    minute < MINUTES_PER_HOUR &&
    minute % MINUTES_PER_QUARTER === 0 &&
    year >= MIN_PROJECT_YEAR &&
    year <= MAX_PROJECT_YEAR &&
    month >= FIRST_MONTH &&
    month <= LAST_MONTH &&
    day >= FIRST_DAY_OF_MONTH &&
    hour >= 0 &&
    hour < HOURS_PER_DAY
  );
}

/** Converts a project hour back into a wall-clock date, hour and minute. */
export function fromProjectHour(hour: ProjectHour): Required<CivilDateTime> {
  const date = new Date(hour * MILLISECONDS_PER_HOUR);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + FIRST_MONTH,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

/** Returns the index of the day containing a project hour. */
export function dayIndexOf(hour: ProjectHour): DayIndex {
  return Math.floor(hour / HOURS_PER_DAY);
}

/** Returns the time of day of a project hour, in hours from 0 up to 24 excluded. */
export function hourOfDay(hour: ProjectHour): number {
  return hour - dayIndexOf(hour) * HOURS_PER_DAY;
}

/** Returns the project hour at midnight of a day. */
export function startOfDay(day: DayIndex): ProjectHour {
  return day * HOURS_PER_DAY;
}

/** Returns the day of the week of a day index. */
export function weekdayOf(day: DayIndex): Weekday {
  const shifted = (day + EPOCH_WEEKDAY) % DAYS_PER_WEEK;
  return ((shifted + DAYS_PER_WEEK) % DAYS_PER_WEEK) as Weekday;
}
