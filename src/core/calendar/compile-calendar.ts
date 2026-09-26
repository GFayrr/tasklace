import { MAX_NON_WORKING_PERIODS, MAX_WORKING_TIME_RANGES } from '../limits';
import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import { failure, success, type Result } from '../result';
import { DAYS_PER_WEEK, HOURS_PER_DAY, MAX_DAY_INDEX, MIN_DAY_INDEX, type Weekday } from '../time';

export interface CompiledCalendar {
  readonly isWorkingWeekday: readonly boolean[];
  readonly workingHoursOfDay: readonly [number, ...number[]];
  readonly nonWorkingPeriods: readonly DayRange[];
}

export type CalendarErrorCode =
  | 'NO_WORKING_WEEKDAY'
  | 'INVALID_WEEKDAY'
  | 'DUPLICATE_WEEKDAY'
  | 'NO_WORKING_TIME_RANGE'
  | 'TOO_MANY_WORKING_TIME_RANGES'
  | 'INVALID_WORKING_TIME_RANGE'
  | 'OVERLAPPING_WORKING_TIME_RANGES'
  | 'TOO_MANY_NON_WORKING_PERIODS'
  | 'INVALID_NON_WORKING_PERIOD';

export interface CalendarError {
  readonly code: CalendarErrorCode;
  readonly index?: number;
}

/** Validates a working calendar and turns it into a structure optimized for time computations. */
export function compileCalendar(
  calendar: WorkingCalendar,
): Result<CompiledCalendar, readonly CalendarError[]> {
  const errors = [
    ...validateWeekdays(calendar.workingWeekdays),
    ...validateTimeRanges(calendar.workingTimeRanges),
    ...validateNonWorkingPeriods(calendar.nonWorkingPeriods),
  ];
  if (errors.length > 0) {
    return failure(errors);
  }
  const [firstHour, ...otherHours] = listWorkingHours(calendar.workingTimeRanges);
  if (firstHour === undefined) {
    return failure([{ code: 'NO_WORKING_TIME_RANGE' }]);
  }
  return success({
    isWorkingWeekday: buildWeekdayMask(calendar.workingWeekdays),
    workingHoursOfDay: [firstHour, ...otherHours],
    nonWorkingPeriods: mergePeriods(calendar.nonWorkingPeriods),
  });
}

/** Reports empty, out-of-range and duplicated working weekdays. */
function validateWeekdays(weekdays: readonly Weekday[]): CalendarError[] {
  if (weekdays.length === 0) {
    return [{ code: 'NO_WORKING_WEEKDAY' }];
  }
  const errors: CalendarError[] = [];
  const seen = new Set<number>();
  weekdays.forEach((weekday, index) => {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday >= DAYS_PER_WEEK) {
      errors.push({ code: 'INVALID_WEEKDAY', index });
    } else if (seen.has(weekday)) {
      errors.push({ code: 'DUPLICATE_WEEKDAY', index });
    }
    seen.add(weekday);
  });
  return errors;
}

/** Reports missing, malformed, excessive and overlapping working time ranges. */
function validateTimeRanges(ranges: readonly TimeRange[]): CalendarError[] {
  if (ranges.length === 0) {
    return [{ code: 'NO_WORKING_TIME_RANGE' }];
  }
  if (ranges.length > MAX_WORKING_TIME_RANGES) {
    return [{ code: 'TOO_MANY_WORKING_TIME_RANGES' }];
  }
  const errors: CalendarError[] = [];
  ranges.forEach((range, index) => {
    if (!isValidTimeRange(range)) {
      errors.push({ code: 'INVALID_WORKING_TIME_RANGE', index });
    }
  });
  if (errors.length === 0 && hasOverlappingRanges(ranges)) {
    errors.push({ code: 'OVERLAPPING_WORKING_TIME_RANGES' });
  }
  return errors;
}

/** Tells whether a time range is made of whole hours inside one day, with a positive length. */
function isValidTimeRange({ startHour, endHour }: TimeRange): boolean {
  return (
    Number.isInteger(startHour) &&
    Number.isInteger(endHour) &&
    startHour >= 0 &&
    startHour < endHour &&
    endHour <= HOURS_PER_DAY
  );
}

/** Tells whether any two valid time ranges share at least one hour. */
function hasOverlappingRanges(ranges: readonly TimeRange[]): boolean {
  const sorted = [...ranges].sort((left, right) => left.startHour - right.startHour);
  return sorted.some((range, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && range.startHour < previous.endHour;
  });
}

/** Reports excessive, malformed and out-of-range non-working periods. */
function validateNonWorkingPeriods(periods: readonly DayRange[]): CalendarError[] {
  if (periods.length > MAX_NON_WORKING_PERIODS) {
    return [{ code: 'TOO_MANY_NON_WORKING_PERIODS' }];
  }
  const errors: CalendarError[] = [];
  periods.forEach((period, index) => {
    if (!isValidDayRange(period)) {
      errors.push({ code: 'INVALID_NON_WORKING_PERIOD', index });
    }
  });
  return errors;
}

/** Tells whether a day range is ordered and inside the supported project period. */
function isValidDayRange({ firstDay, lastDay }: DayRange): boolean {
  return (
    Number.isInteger(firstDay) &&
    Number.isInteger(lastDay) &&
    firstDay >= MIN_DAY_INDEX &&
    firstDay <= lastDay &&
    lastDay <= MAX_DAY_INDEX
  );
}

/** Builds a lookup table telling, for each weekday, whether it is worked. */
function buildWeekdayMask(weekdays: readonly Weekday[]): boolean[] {
  const mask = new Array<boolean>(DAYS_PER_WEEK).fill(false);
  weekdays.forEach((weekday) => {
    mask[weekday] = true;
  });
  return mask;
}

/** Lists every worked hour of the day in ascending order. */
function listWorkingHours(ranges: readonly TimeRange[]): number[] {
  const hours: number[] = [];
  for (const range of ranges) {
    for (let hour = range.startHour; hour < range.endHour; hour += 1) {
      hours.push(hour);
    }
  }
  return hours.sort((left, right) => left - right);
}

/** Sorts non-working periods and merges those that overlap or touch. */
function mergePeriods(periods: readonly DayRange[]): DayRange[] {
  const sorted = [...periods].sort((left, right) => left.firstDay - right.firstDay);
  const merged: DayRange[] = [];
  for (const period of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && period.firstDay <= last.lastDay + 1) {
      merged[merged.length - 1] = {
        firstDay: last.firstDay,
        lastDay: Math.max(last.lastDay, period.lastDay),
      };
    } else {
      merged.push(period);
    }
  }
  return merged;
}
