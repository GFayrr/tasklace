import { MAX_TASK_DURATION_HOURS } from '../limits';
import { failure, success, type Result } from '../result';
import {
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  dayIndexOf,
  hourOfDay,
  isProjectHour,
  startOfDay,
  type DayIndex,
  type ProjectHour,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';

export type WorkingTimeErrorCode =
  'INVALID_INSTANT' | 'INVALID_INTERVAL' | 'INVALID_HOURS' | 'BEYOND_PLANNING_HORIZON';

/** Tells whether a day of the supported period has working hours. */
export function isWorkingDay(calendar: CompiledCalendar, day: DayIndex): boolean {
  if (day < MIN_DAY_INDEX || day > MAX_DAY_INDEX) {
    return false;
  }
  return workingHoursBeforeDay(calendar, day + 1) > workingHoursBeforeDay(calendar, day);
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
  const hoursPerWorkingDay = calendar.workingHoursOfDay.length;
  const rank = workingHoursBeforeDay(calendar, workingDay) / hoursPerWorkingDay + count;
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

/** Returns the start of the first working hour at or after an instant. */
export function nextWorkingHour(
  calendar: CompiledCalendar,
  instant: ProjectHour,
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (!isProjectHour(instant)) {
    return failure('INVALID_INSTANT');
  }
  return boundaryOfWorkingHour(calendar, workingHoursBefore(calendar, instant), 'start');
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
  return boundaryOfWorkingHour(calendar, workingHoursBefore(calendar, from) + hours - 1, 'end');
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
  return boundaryOfWorkingHour(calendar, workingHoursBefore(calendar, to) - hours, 'start');
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

/** Moves an instant back to the end of the last working hour at or before it, when one exists. */
export function lastWorkingHourEnd(
  calendar: CompiledCalendar,
  instant: ProjectHour,
): Result<ProjectHour, WorkingTimeErrorCode> {
  const lastHourStart = subtractWorkingHours(calendar, instant, 1);
  return lastHourStart.ok ? success(lastHourStart.value + 1) : lastHourStart;
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
  return success(workingHoursBefore(calendar, to) - workingHoursBefore(calendar, from));
}

/** Tells whether no working hour lies between two instants of the supported period, the second one excluded. */
export function isIdleBetween(
  calendar: CompiledCalendar,
  from: ProjectHour,
  to: ProjectHour,
): boolean {
  return workingHoursBefore(calendar, to) === workingHoursBefore(calendar, from);
}

/** Lists the worked hours of the day that are at or after an hour of the day. */
export function workingHoursFrom(calendar: CompiledCalendar, minimumHourOfDay: number): number[] {
  return calendar.workingHoursOfDay.filter((hour) => hour >= minimumHourOfDay);
}

/** Tells whether a number of hours is a whole, non-negative and supported amount. */
function isValidHourCount(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 0 && hours <= MAX_TASK_DURATION_HOURS;
}

/** Returns the number of working hours of the supported period that start before a day. */
function workingHoursBeforeDay(calendar: CompiledCalendar, day: DayIndex): number {
  return calendar.workingHoursBeforeDay[day - MIN_DAY_INDEX] ?? 0;
}

/** Returns the number of working hours of the whole supported period. */
function totalWorkingHours(calendar: CompiledCalendar): number {
  return workingHoursBeforeDay(calendar, MAX_DAY_INDEX + 1);
}

/** Counts the working hours of the supported period that are over at a given instant. */
function workingHoursBefore(calendar: CompiledCalendar, instant: ProjectHour): number {
  const day = dayIndexOf(instant);
  const beforeDay = workingHoursBeforeDay(calendar, day);
  if (!isWorkingDay(calendar, day)) {
    return beforeDay;
  }
  return beforeDay + (calendar.workingHoursBeforeHourOfDay[hourOfDay(instant)] ?? 0);
}

/** Returns the start or the end of the working hour with a given rank (0 being the first one). */
function boundaryOfWorkingHour(
  calendar: CompiledCalendar,
  rank: number,
  boundary: 'start' | 'end',
): Result<ProjectHour, WorkingTimeErrorCode> {
  if (rank < 0 || rank >= totalWorkingHours(calendar)) {
    return failure('BEYOND_PLANNING_HORIZON');
  }
  const day = dayOfWorkingHour(calendar, rank);
  const hour = calendar.workingHoursOfDay[rank - workingHoursBeforeDay(calendar, day)] ?? 0;
  return success(startOfDay(day) + hour + (boundary === 'end' ? 1 : 0));
}

/** Returns the day containing the working hour with a given rank, every working day having the same number of hours. */
function dayOfWorkingHour(calendar: CompiledCalendar, rank: number): DayIndex {
  const dayRank = Math.floor(rank / calendar.workingHoursOfDay.length);
  return MIN_DAY_INDEX + (calendar.workingDayOffsetsByRank[dayRank] ?? 0);
}
