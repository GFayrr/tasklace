import type { Schedule } from '../../core/scheduling/schedule-project';
import { valueAt } from '../../core/table-value';
import {
  startOfDay,
  weekdayOf,
  type DayIndex,
  type ProjectHour,
  type Weekday,
} from '../../core/time';

export interface ProjectSpan {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

const MILLISECONDS_PER_HOUR = 3_600_000;
const DAYS_PER_WEEK = 7;
const FIRST_WEEK_DAY: DayIndex = 0;

/** Creates a function writing the day of a project hour in the regional format, project hours being wall-clock times without time zone. */
export function createDayFormatter(locale: string): (hour: ProjectHour) => string {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  return (hour) => format.format(new Date(hour * MILLISECONDS_PER_HOUR));
}

/** Returns the earliest start and the latest end of the tasks of a schedule, or null when it places no task. */
export function projectSpan(schedule: Schedule): ProjectSpan | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const placement of schedule.placements.values()) {
    start = Math.min(start, placement.start);
    end = Math.max(end, placement.end);
  }
  return schedule.placements.size === 0 ? null : { start, end };
}

/** Creates a function writing the short name of a weekday in the language of the system, as "Mon" or "lun.". */
export function createWeekdayNamer(locale: string): (weekday: Weekday) => string {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const names: string[] = [];
  for (let day = FIRST_WEEK_DAY; day < FIRST_WEEK_DAY + DAYS_PER_WEEK; day += 1) {
    names[weekdayOf(day)] = format.format(new Date(startOfDay(day) * MILLISECONDS_PER_HOUR));
  }
  return (weekday) => valueAt(names, weekday);
}

const MOMENT_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
};

/** Creates a function writing a project hour with its day and time in the regional format, as "Fri, Oct 23, 5:00 PM". */
export function createMomentFormatter(locale: string): (hour: ProjectHour) => string {
  const format = new Intl.DateTimeFormat(locale, MOMENT_OPTIONS);
  return (hour) => format.format(new Date(hour * MILLISECONDS_PER_HOUR));
}

/** Creates a function writing a period between two project hours in the regional format, the day written once when both fall on it. */
export function createPeriodFormatter(
  locale: string,
): (start: ProjectHour, end: ProjectHour) => string {
  const format = new Intl.DateTimeFormat(locale, MOMENT_OPTIONS);
  return (start, end) =>
    format.formatRange(
      new Date(start * MILLISECONDS_PER_HOUR),
      new Date(end * MILLISECONDS_PER_HOUR),
    );
}
