import { MAX_NON_WORKING_PERIODS, MAX_WORKING_TIME_RANGES } from '../limits';
import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import { failure, success, type Result } from '../result';
import {
  DAYS_PER_WEEK,
  fromQuarters,
  HOURS_PER_DAY,
  isQuarterHours,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  QUARTERS_PER_DAY,
  toQuarters,
  weekdayOf,
  type Weekday,
} from '../time';

const COPY_GROWTH_FACTOR = 2;
const MAX_CACHED_CALENDARS = 8;
const compiledCalendars = new Map<string, CompiledCalendar>();

export interface CompiledCalendar {
  readonly workingHoursPerDay: number;
  readonly workingQuartersOfDay: readonly [number, ...number[]];
  readonly workingQuartersBeforeQuarterOfDay: readonly number[];
  readonly workingQuartersBeforeDay: Int32Array;
  readonly nextWorkingDayOffsets: Int32Array;
  readonly previousWorkingDayOffsets: Int32Array;
  readonly workingDayOffsetsByRank: Int32Array;
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

/** Validates a working calendar and turns it into a structure optimized for time computations, reusing the result for a calendar with the same content. */
export function compileCalendar(
  calendar: WorkingCalendar,
): Result<CompiledCalendar, readonly CalendarError[]> {
  const key = calendarKey(calendar);
  const cached = compiledCalendars.get(key);
  if (cached !== undefined) {
    return success(cached);
  }
  const compiled = compileUncached(calendar);
  if (compiled.ok) {
    rememberCalendar(key, compiled.value);
  }
  return compiled;
}

/** Builds a key that is the same for two calendars with the same content, whatever the order of object properties. */
function calendarKey(calendar: WorkingCalendar): string {
  return JSON.stringify([
    calendar.workingWeekdays,
    calendar.workingTimeRanges.map((range) => [range.startHour, range.endHour]),
    calendar.nonWorkingPeriods.map((period) => [period.firstDay, period.lastDay]),
  ]);
}

/** Keeps a compiled calendar for later reuse, forgetting the oldest one beyond the cache size. */
function rememberCalendar(key: string, compiled: CompiledCalendar): void {
  compiledCalendars.set(key, compiled);
  const [oldestKey] = compiledCalendars.keys();
  if (compiledCalendars.size > MAX_CACHED_CALENDARS && oldestKey !== undefined) {
    compiledCalendars.delete(oldestKey);
  }
}

/** Validates a working calendar and builds all its lookup tables. */
function compileUncached(
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
  const [firstQuarter, ...otherQuarters] = listWorkingQuarters(calendar.workingTimeRanges);
  if (firstQuarter === undefined) {
    return failure([{ code: 'NO_WORKING_TIME_RANGE' }]);
  }
  const workingQuartersOfDay: [number, ...number[]] = [firstQuarter, ...otherQuarters];
  const workingQuartersBeforeDay = accumulateWorkingQuartersPerDay(
    buildWeekdayMask(calendar.workingWeekdays),
    calendar.nonWorkingPeriods,
    workingQuartersOfDay.length,
  );
  return success({
    workingHoursPerDay: fromQuarters(workingQuartersOfDay.length),
    workingQuartersOfDay,
    workingQuartersBeforeQuarterOfDay: countQuartersBeforeEachQuarterOfDay(workingQuartersOfDay),
    workingQuartersBeforeDay,
    nextWorkingDayOffsets: linkWorkingDays(workingQuartersBeforeDay, 'next'),
    previousWorkingDayOffsets: linkWorkingDays(workingQuartersBeforeDay, 'previous'),
    workingDayOffsetsByRank: listWorkingDays(workingQuartersBeforeDay, workingQuartersOfDay.length),
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

/** Tells whether a time range is made of whole quarter hours inside one day, with a positive length. */
function isValidTimeRange({ startHour, endHour }: TimeRange): boolean {
  return (
    isQuarterHours(startHour) &&
    isQuarterHours(endHour) &&
    startHour >= 0 &&
    startHour < endHour &&
    endHour <= HOURS_PER_DAY
  );
}

/** Tells whether any two valid time ranges share at least one quarter hour. */
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

/** Gives, for each day of the supported period, the offset of the nearest working day in one direction, that day included, or -1 when there is none. */
function linkWorkingDays(
  workingQuartersBeforeDay: Int32Array,
  direction: 'next' | 'previous',
): Int32Array {
  const dayCount = workingQuartersBeforeDay.length - 1;
  const links = new Int32Array(dayCount);
  const step = direction === 'next' ? -1 : 1;
  let nearest = -1;
  for (
    let offset = direction === 'next' ? dayCount - 1 : 0;
    offset >= 0 && offset < dayCount;
    offset += step
  ) {
    const worked =
      (workingQuartersBeforeDay[offset + 1] ?? 0) > (workingQuartersBeforeDay[offset] ?? 0);
    nearest = worked ? offset : nearest;
    links[offset] = nearest;
  }
  return links;
}

/** Lists the offset of every working day of the supported period, in order, so that the day of a working quarter hour is found by its rank. */
function listWorkingDays(
  workingQuartersBeforeDay: Int32Array,
  quartersPerWorkingDay: number,
): Int32Array {
  const dayCount = workingQuartersBeforeDay.length - 1;
  const total = workingQuartersBeforeDay[dayCount] ?? 0;
  const workingDays = new Int32Array(total / quartersPerWorkingDay);
  let rank = 0;
  for (let offset = 0; offset < dayCount; offset += 1) {
    if ((workingQuartersBeforeDay[offset + 1] ?? 0) > (workingQuartersBeforeDay[offset] ?? 0)) {
      workingDays[rank] = offset;
      rank += 1;
    }
  }
  return workingDays;
}

/** Builds a lookup table telling, for each weekday, whether it is worked. */
function buildWeekdayMask(weekdays: readonly Weekday[]): boolean[] {
  const mask = new Array<boolean>(DAYS_PER_WEEK).fill(false);
  weekdays.forEach((weekday) => {
    mask[weekday] = true;
  });
  return mask;
}

/** Lists the start of every worked quarter hour of the day, in hours and ascending order. */
function listWorkingQuarters(ranges: readonly TimeRange[]): number[] {
  const quarters: number[] = [];
  for (const range of ranges) {
    for (
      let quarter = toQuarters(range.startHour);
      quarter < toQuarters(range.endHour);
      quarter += 1
    ) {
      quarters.push(fromQuarters(quarter));
    }
  }
  return quarters.sort((left, right) => left - right);
}

/** Counts, for each quarter hour of the day from the first to the end of the day, the working quarter hours that start before it. */
function countQuartersBeforeEachQuarterOfDay(workingQuartersOfDay: readonly number[]): number[] {
  const counts: number[] = [];
  let before = 0;
  for (let quarter = 0; quarter <= QUARTERS_PER_DAY; quarter += 1) {
    counts.push(before);
    before += workingQuartersOfDay.includes(fromQuarters(quarter)) ? 1 : 0;
  }
  return counts;
}

/** Builds the running total of working quarter hours before each day of the supported period. */
function accumulateWorkingQuartersPerDay(
  weekdayMask: readonly boolean[],
  periods: readonly DayRange[],
  quartersPerWorkingDay: number,
): Int32Array {
  const dayCount = MAX_DAY_INDEX - MIN_DAY_INDEX + 1;
  const dailyQuarters = new Int32Array(dayCount);
  fillWeeklyPattern(dailyQuarters, weekdayMask, quartersPerWorkingDay);
  for (const period of periods) {
    dailyQuarters.fill(0, period.firstDay - MIN_DAY_INDEX, period.lastDay - MIN_DAY_INDEX + 1);
  }
  const totals = new Int32Array(dayCount + 1);
  for (let offset = 0; offset < dayCount; offset += 1) {
    totals[offset + 1] = (totals[offset] ?? 0) + (dailyQuarters[offset] ?? 0);
  }
  return totals;
}

/** Fills the working quarter hours of every day by writing the first week, then copying it forward in doubling blocks. */
function fillWeeklyPattern(
  dailyQuarters: Int32Array,
  weekdayMask: readonly boolean[],
  quartersPerWorkingDay: number,
): void {
  const firstWeekLength = Math.min(DAYS_PER_WEEK, dailyQuarters.length);
  for (let offset = 0; offset < firstWeekLength; offset += 1) {
    const worked = weekdayMask[weekdayOf(MIN_DAY_INDEX + offset)] === true;
    dailyQuarters[offset] = worked ? quartersPerWorkingDay : 0;
  }
  for (let filled = firstWeekLength; filled < dailyQuarters.length; filled *= COPY_GROWTH_FACTOR) {
    dailyQuarters.copyWithin(filled, 0, filled);
  }
}
