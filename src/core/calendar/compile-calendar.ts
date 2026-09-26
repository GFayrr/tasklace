import { MAX_NON_WORKING_PERIODS, MAX_WORKING_TIME_RANGES } from '../limits';
import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import { failure, success, type Result } from '../result';
import {
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  weekdayOf,
  type Weekday,
} from '../time';

const COPY_GROWTH_FACTOR = 2;

export interface CompiledCalendar {
  readonly workingHoursOfDay: readonly [number, ...number[]];
  readonly workingHoursBeforeHourOfDay: readonly number[];
  readonly workingHoursBeforeDay: Int32Array;
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
  const workingHoursOfDay: [number, ...number[]] = [firstHour, ...otherHours];
  return success({
    workingHoursOfDay,
    workingHoursBeforeHourOfDay: countHoursBeforeEachHourOfDay(workingHoursOfDay),
    workingHoursBeforeDay: accumulateWorkingHoursPerDay(
      buildWeekdayMask(calendar.workingWeekdays),
      calendar.nonWorkingPeriods,
      workingHoursOfDay.length,
    ),
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

/** Counts, for each hour of the day from 0 to 24, the working hours of a day that start before it. */
function countHoursBeforeEachHourOfDay(workingHoursOfDay: readonly number[]): number[] {
  return Array.from(
    { length: HOURS_PER_DAY + 1 },
    (_value, hour) => workingHoursOfDay.filter((workingHour) => workingHour < hour).length,
  );
}

/** Builds the running total of working hours before each day of the supported period. */
function accumulateWorkingHoursPerDay(
  weekdayMask: readonly boolean[],
  periods: readonly DayRange[],
  hoursPerWorkingDay: number,
): Int32Array {
  const dayCount = MAX_DAY_INDEX - MIN_DAY_INDEX + 1;
  const dailyHours = new Int32Array(dayCount);
  fillWeeklyPattern(dailyHours, weekdayMask, hoursPerWorkingDay);
  for (const period of periods) {
    dailyHours.fill(0, period.firstDay - MIN_DAY_INDEX, period.lastDay - MIN_DAY_INDEX + 1);
  }
  const totals = new Int32Array(dayCount + 1);
  for (let offset = 0; offset < dayCount; offset += 1) {
    totals[offset + 1] = (totals[offset] ?? 0) + (dailyHours[offset] ?? 0);
  }
  return totals;
}

/** Fills the hours of every day by writing the first week, then copying it forward in doubling blocks. */
function fillWeeklyPattern(
  dailyHours: Int32Array,
  weekdayMask: readonly boolean[],
  hoursPerWorkingDay: number,
): void {
  const firstWeekLength = Math.min(DAYS_PER_WEEK, dailyHours.length);
  for (let offset = 0; offset < firstWeekLength; offset += 1) {
    const worked = weekdayMask[weekdayOf(MIN_DAY_INDEX + offset)] === true;
    dailyHours[offset] = worked ? hoursPerWorkingDay : 0;
  }
  for (let filled = firstWeekLength; filled < dailyHours.length; filled *= COPY_GROWTH_FACTOR) {
    dailyHours.copyWithin(filled, 0, filled);
  }
}
