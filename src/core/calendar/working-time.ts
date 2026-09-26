import { MAX_TASK_DURATION_HOURS } from '../limits';
import type { DayRange } from '../model/calendar';
import { failure, success, type Result } from '../result';
import {
  HOURS_PER_DAY,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  dayIndexOf,
  hourOfDay,
  isProjectHour,
  startOfDay,
  weekdayOf,
  type DayIndex,
  type ProjectHour,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';

export type WorkingTimeErrorCode =
  'INVALID_INSTANT' | 'INVALID_INTERVAL' | 'INVALID_HOURS' | 'BEYOND_PLANNING_HORIZON';

/** Returns the first working day on or after a day, or null past the planning horizon. */
export function nextWorkingDay(calendar: CompiledCalendar, day: DayIndex): DayIndex | null {
  let candidate = Math.max(day, MIN_DAY_INDEX);
  while (candidate <= MAX_DAY_INDEX) {
    const period = findCoveringPeriod(calendar.nonWorkingPeriods, candidate);
    if (period !== undefined) {
      candidate = period.lastDay + 1;
    } else if (calendar.isWorkingWeekday[weekdayOf(candidate)] === true) {
      return candidate;
    } else {
      candidate += 1;
    }
  }
  return null;
}

/** Returns the last working day on or before a day, or null before the planning horizon. */
export function previousWorkingDay(calendar: CompiledCalendar, day: DayIndex): DayIndex | null {
  let candidate = Math.min(day, MAX_DAY_INDEX);
  while (candidate >= MIN_DAY_INDEX) {
    const period = findCoveringPeriod(calendar.nonWorkingPeriods, candidate);
    if (period !== undefined) {
      candidate = period.firstDay - 1;
    } else if (calendar.isWorkingWeekday[weekdayOf(candidate)] === true) {
      return candidate;
    } else {
      candidate -= 1;
    }
  }
  return null;
}

/** Returns the start of the first working hour at or after an instant. */
export function nextWorkingHour(
  calendar: CompiledCalendar,
  instant: ProjectHour,
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (!isProjectHour(instant)) {
    return failure('INVALID_INSTANT');
  }
  return addWorkingHoursUnchecked(calendar, instant, 1, 'start');
}

/** Returns the instant at which a number of working hours, counted from an instant, is over. */
export function addWorkingHours(
  calendar: CompiledCalendar,
  from: ProjectHour,
  hours: number,
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (!isProjectHour(from)) {
    return failure('INVALID_INSTANT');
  }
  if (!isValidHourCount(hours)) {
    return failure('INVALID_HOURS');
  }
  return hours === 0 ? success(from) : addWorkingHoursUnchecked(calendar, from, hours, 'end');
}

/** Returns the instant from which a number of working hours ends exactly at a given instant. */
export function subtractWorkingHours(
  calendar: CompiledCalendar,
  to: ProjectHour,
  hours: number,
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (!isProjectHour(to)) {
    return failure('INVALID_INSTANT');
  }
  if (!isValidHourCount(hours)) {
    return failure('INVALID_HOURS');
  }
  return hours === 0 ? success(to) : subtractWorkingHoursUnchecked(calendar, to, hours);
}

/** Counts the working hours between two instants, the end being excluded. */
export function countWorkingHours(
  calendar: CompiledCalendar,
  from: ProjectHour,
  to: ProjectHour,
): Result<number, WorkingTimeErrorCode> {
  if (!isProjectHour(from) || !isProjectHour(to)) {
    return failure('INVALID_INSTANT');
  }
  if (from > to) {
    return failure('INVALID_INTERVAL');
  }
  let total = 0;
  let day = nextWorkingDay(calendar, dayIndexOf(from));
  while (day !== null && startOfDay(day) < to) {
    total += countWorkingHoursOfDayBetween(calendar, day, from, to);
    day = nextWorkingDay(calendar, day + 1);
  }
  return success(total);
}

/** Lists the worked hours of the day that are at or after an hour of the day. */
export function workingHoursFrom(calendar: CompiledCalendar, minimumHourOfDay: number): number[] {
  return calendar.workingHoursOfDay.filter((hour) => hour >= minimumHourOfDay);
}

/** Tells whether a number of hours is a whole, non-negative and supported amount. */
function isValidHourCount(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 0 && hours <= MAX_TASK_DURATION_HOURS;
}

/** Walks forward through working hours and returns the start or the end of the last one consumed. */
function addWorkingHoursUnchecked(
  calendar: CompiledCalendar,
  from: ProjectHour,
  hours: number,
  boundary: 'start' | 'end',
): Result<ProjectHour, WorkingTimeErrorCode> {
  let remaining = hours;
  let cursor = from;
  for (;;) {
    const day = nextWorkingDay(calendar, dayIndexOf(cursor));
    if (day === null) {
      return failure('BEYOND_PLANNING_HORIZON');
    }
    const minimumHour = day === dayIndexOf(cursor) ? hourOfDay(cursor) : 0;
    const available = workingHoursFrom(calendar, minimumHour);
    const lastHour = available[remaining - 1];
    if (lastHour !== undefined) {
      return success(startOfDay(day) + lastHour + (boundary === 'end' ? 1 : 0));
    }
    remaining -= available.length;
    cursor = startOfDay(day + 1);
  }
}

/** Walks backward through working hours and returns the start of the last one consumed. */
function subtractWorkingHoursUnchecked(
  calendar: CompiledCalendar,
  to: ProjectHour,
  hours: number,
): Result<ProjectHour, WorkingTimeErrorCode> {
  let remaining = hours;
  let cursor = to;
  for (;;) {
    const lastInstant = cursor - 1;
    const day = previousWorkingDay(calendar, dayIndexOf(lastInstant));
    if (day === null) {
      return failure('BEYOND_PLANNING_HORIZON');
    }
    const endHour = day === dayIndexOf(lastInstant) ? hourOfDay(lastInstant) + 1 : HOURS_PER_DAY;
    const available = calendar.workingHoursOfDay.filter((hour) => hour < endHour);
    const firstHour = available[available.length - remaining];
    if (firstHour !== undefined) {
      return success(startOfDay(day) + firstHour);
    }
    remaining -= available.length;
    cursor = startOfDay(day);
  }
}

/** Counts the worked hours of one day that lie fully inside an interval. */
function countWorkingHoursOfDayBetween(
  calendar: CompiledCalendar,
  day: DayIndex,
  from: ProjectHour,
  to: ProjectHour,
): number {
  const dayStart = startOfDay(day);
  return calendar.workingHoursOfDay.filter(
    (hour) => dayStart + hour >= from && dayStart + hour + 1 <= to,
  ).length;
}

/** Finds, by binary search, the sorted non-working period that contains a day. */
function findCoveringPeriod(periods: readonly DayRange[], day: DayIndex): DayRange | undefined {
  let low = 0;
  let high = periods.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const period = periods[middle];
    if (period === undefined || day < period.firstDay) {
      high = middle - 1;
    } else if (day > period.lastDay) {
      low = middle + 1;
    } else {
      return period;
    }
  }
  return undefined;
}
