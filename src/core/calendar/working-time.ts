import { MAX_TASK_DURATION_HOURS } from '../limits';
import { failure, success, type Result } from '../result';
import {
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  QUARTER_HOUR,
  dayIndexOf,
  fromQuarters,
  hourOfDay,
  isProjectHour,
  isQuarterHours,
  startOfDay,
  toQuarters,
  type DayIndex,
  type ProjectHour,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';
import { valueAt } from '../table-value';

export type WorkingTimeErrorCode =
  'INVALID_INSTANT' | 'INVALID_INTERVAL' | 'INVALID_HOURS' | 'BEYOND_PLANNING_HORIZON';

/** Tells whether a day of the supported period has working hours. */
export function isWorkingDay(calendar: CompiledCalendar, day: DayIndex): boolean {
  if (day < MIN_DAY_INDEX || day > MAX_DAY_INDEX) {
    return false;
  }
  return workingQuartersBeforeDay(calendar, day + 1) > workingQuartersBeforeDay(calendar, day);
}

/** Returns the first working day on or after a day, or null past the planning horizon. */
export function nextWorkingDay(calendar: CompiledCalendar, day: DayIndex): DayIndex | null {
  if (day > MAX_DAY_INDEX) {
    return null;
  }
  const offset = calendar.nextWorkingDayOffsets[Math.max(day, MIN_DAY_INDEX) - MIN_DAY_INDEX] ?? -1;
  return offset < 0 ? null : MIN_DAY_INDEX + offset;
}

/** Returns the working day that comes a given number of working days after a working day, or null past the planning horizon. */
export function workingDayAfter(
  calendar: CompiledCalendar,
  workingDay: DayIndex,
  count: number,
): DayIndex | null {
  const quartersPerWorkingDay = calendar.workingQuarterStartHours.length;
  const rank = workingQuartersBeforeDay(calendar, workingDay) / quartersPerWorkingDay + count;
  const offset = calendar.workingDayOffsetsByRank[rank];
  return offset === undefined ? null : MIN_DAY_INDEX + offset;
}

/** Returns the last working day on or before a day, or null before the planning horizon. */
export function previousWorkingDay(calendar: CompiledCalendar, day: DayIndex): DayIndex | null {
  if (day < MIN_DAY_INDEX) {
    return null;
  }
  const offset =
    calendar.previousWorkingDayOffsets[Math.min(day, MAX_DAY_INDEX) - MIN_DAY_INDEX] ?? -1;
  return offset < 0 ? null : MIN_DAY_INDEX + offset;
}

/** Returns the start of the first working quarter hour at or after an instant. */
export function nextWorkingHour(
  calendar: CompiledCalendar,
  instant: ProjectHour,
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (!isProjectHour(instant)) {
    return failure('INVALID_INSTANT');
  }
  return boundaryOfWorkingQuarter(calendar, workingQuartersBefore(calendar, instant), 'start');
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
  if (hours === 0) {
    return success(from);
  }
  const last = workingQuartersBefore(calendar, from) + toQuarters(hours) - 1;
  return boundaryOfWorkingQuarter(calendar, last, 'end');
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
  if (hours === 0) {
    return success(to);
  }
  const first = workingQuartersBefore(calendar, to) - toQuarters(hours);
  return boundaryOfWorkingQuarter(calendar, first, 'start');
}

/** Moves an instant forward by a positive number of working hours, or backward by a negative one. */
export function shiftWorkingHours(
  calendar: CompiledCalendar,
  instant: ProjectHour,
  hours: number,
): Result<ProjectHour, WorkingTimeErrorCode> {
  return hours >= 0
    ? addWorkingHours(calendar, instant, hours)
    : subtractWorkingHours(calendar, instant, -hours);
}

/** Moves an instant back to the end of the last working quarter hour at or before it, when one exists. */
export function lastWorkingHourEnd(
  calendar: CompiledCalendar,
  instant: ProjectHour,
): Result<ProjectHour, WorkingTimeErrorCode> {
  const lastQuarterStart = subtractWorkingHours(calendar, instant, QUARTER_HOUR);
  return lastQuarterStart.ok ? success(lastQuarterStart.value + QUARTER_HOUR) : lastQuarterStart;
}

/** Counts the working hours from one instant to another, negative when the second comes first. */
export function signedWorkingHoursBetween(
  calendar: CompiledCalendar,
  from: ProjectHour,
  to: ProjectHour,
): Result<number, WorkingTimeErrorCode> {
  if (from <= to) {
    return countWorkingHours(calendar, from, to);
  }
  const reversed = countWorkingHours(calendar, to, from);
  return reversed.ok ? success(-reversed.value) : reversed;
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
  return success(
    fromQuarters(workingQuartersBefore(calendar, to) - workingQuartersBefore(calendar, from)),
  );
}

/** Tells whether no working hour lies between two instants of the supported period, the second one excluded. */
export function isIdleBetween(
  calendar: CompiledCalendar,
  from: ProjectHour,
  to: ProjectHour,
): boolean {
  return workingQuartersBefore(calendar, to) === workingQuartersBefore(calendar, from);
}

/** Lists the start of the worked quarter hours of the day that are at or after a time of day. */
export function workingHoursFrom(calendar: CompiledCalendar, minimumHourOfDay: number): number[] {
  return calendar.workingQuarterStartHours.filter((quarter) => quarter >= minimumHourOfDay);
}

/** Tells whether a number of hours is a whole number of quarter hours, non-negative and supported. */
function isValidHourCount(hours: number): boolean {
  return isQuarterHours(hours) && hours >= 0 && hours <= MAX_TASK_DURATION_HOURS;
}

/** Returns the number of working quarter hours of the supported period that start before a day. */
function workingQuartersBeforeDay(calendar: CompiledCalendar, day: DayIndex): number {
  return valueAt(calendar.workingQuartersBeforeDay, day - MIN_DAY_INDEX);
}

/** Returns the number of working quarter hours of the whole supported period. */
function totalWorkingQuarters(calendar: CompiledCalendar): number {
  return workingQuartersBeforeDay(calendar, MAX_DAY_INDEX + 1);
}

/** Counts the working quarter hours of the supported period that are over at a given instant. */
function workingQuartersBefore(calendar: CompiledCalendar, instant: ProjectHour): number {
  const day = dayIndexOf(instant);
  const beforeDay = workingQuartersBeforeDay(calendar, day);
  if (!isWorkingDay(calendar, day)) {
    return beforeDay;
  }
  const quarterOfDay = toQuarters(hourOfDay(instant));
  return beforeDay + valueAt(calendar.workingQuartersBeforeQuarterOfDay, quarterOfDay);
}

/** Returns the start or the end of the working quarter hour with a given rank (0 being the first one). */
function boundaryOfWorkingQuarter(
  calendar: CompiledCalendar,
  rank: number,
  boundary: 'start' | 'end',
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (rank < 0 || rank >= totalWorkingQuarters(calendar)) {
    return failure('BEYOND_PLANNING_HORIZON');
  }
  const day = dayOfWorkingQuarter(calendar, rank);
  const start = valueAt(
    calendar.workingQuarterStartHours,
    rank - workingQuartersBeforeDay(calendar, day),
  );
  return success(startOfDay(day) + start + (boundary === 'end' ? QUARTER_HOUR : 0));
}

/** Returns the day containing the working quarter hour with a given rank, every working day having the same number of them. */
function dayOfWorkingQuarter(calendar: CompiledCalendar, rank: number): DayIndex {
  const dayRank = Math.floor(rank / calendar.workingQuarterStartHours.length);
  return MIN_DAY_INDEX + valueAt(calendar.workingDayOffsetsByRank, dayRank);
}
