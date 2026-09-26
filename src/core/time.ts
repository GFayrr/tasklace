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
}

export const SUNDAY: Weekday = 0;
export const MONDAY: Weekday = 1;
export const TUESDAY: Weekday = 2;
export const WEDNESDAY: Weekday = 3;
export const THURSDAY: Weekday = 4;
export const FRIDAY: Weekday = 5;
export const SATURDAY: Weekday = 6;

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;

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

/** Tells whether a value is a whole hour inside the supported project period. */
export function isProjectHour(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PROJECT_HOUR && value < END_PROJECT_HOUR;
}

/** Converts a wall-clock date and hour, without time zone, into a project hour. */
export function toProjectHour(dateTime: CivilDateTime): Result<ProjectHour, 'INVALID_DATE_TIME'> {
  if (!hasValidDateTimeFields(dateTime)) {
    return failure('INVALID_DATE_TIME');
  }
  const { year, month, day, hour } = dateTime;
  const date = new Date(Date.UTC(year, month - FIRST_MONTH, day, hour));
  if (date.getUTCMonth() !== month - FIRST_MONTH || date.getUTCDate() !== day) {
    return failure('INVALID_DATE_TIME');
  }
  return success(date.getTime() / MILLISECONDS_PER_HOUR);
}

/** Checks the ranges of each date and hour field before any conversion. */
function hasValidDateTimeFields({ year, month, day, hour }: CivilDateTime): boolean {
  const allIntegers = [year, month, day, hour].every((field) => Number.isInteger(field));
  return (
    allIntegers &&
    year >= MIN_PROJECT_YEAR &&
    year <= MAX_PROJECT_YEAR &&
    month >= FIRST_MONTH &&
    month <= LAST_MONTH &&
    day >= FIRST_DAY_OF_MONTH &&
    hour >= 0 &&
    hour < HOURS_PER_DAY
  );
}

/** Converts a project hour back into a wall-clock date and hour. */
export function fromProjectHour(hour: ProjectHour): CivilDateTime {
  const date = new Date(hour * MILLISECONDS_PER_HOUR);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + FIRST_MONTH,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
  };
}

/** Returns the index of the day containing a project hour. */
export function dayIndexOf(hour: ProjectHour): DayIndex {
  return Math.floor(hour / HOURS_PER_DAY);
}

/** Returns the hour of the day (0 to 23) of a project hour. */
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
