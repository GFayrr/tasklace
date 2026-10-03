import { MAX_TASK_DURATION_HOURS } from '../limits';
import type { TimeRange } from '../model/calendar';
import { failure, success, type Result } from '../result';
import {
  HOURS_PER_DAY,
  QUARTER_HOUR,
  dayIndexOf,
  hourOfDay,
  isProjectHour,
  isQuarterHours,
  startOfDay,
  toQuarters,
  type DayIndex,
  type ProjectHour,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';
import {
  nextWorkingDay,
  nextWorkingHour,
  workingDayAfter,
  workingHoursFrom,
  type WorkingTimeErrorCode,
} from './working-time';
import { valueAt } from '../table-value';

const MIN_HOURS_PER_DAY = 1;

export interface TaskPlacement {
  readonly start: ProjectHour;
  readonly durationHours: number;
  readonly hoursPerDay: number | null;
  readonly dailyStartHour: number | null;
}

export interface TimeSlot {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

export type DailyWindowErrorCode = 'INVALID_HOURS_PER_DAY' | 'INVALID_DAILY_START_HOUR';
export type TaskSlotsErrorCode = WorkingTimeErrorCode | 'INVALID_DURATION' | DailyWindowErrorCode;

export interface SegmentBounds {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

/** Computes the exact working time slots a task occupies, from its start to its last hour. */
export function computeTaskSlots(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
): Result<TimeSlot[], TaskSlotsErrorCode> {
  const window = checkPlacement(calendar, placement);
  if (!window.ok) {
    return window;
  }
  if (placement.durationHours === 0) {
    return success([]);
  }
  return collectTaskSlots(calendar, placement, window.value);
}

/** Computes where a block of work starts and ends straight from the calendar tables, whatever its length, as its first and last time slots would. */
export function computeSegmentBounds(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
): Result<SegmentBounds, TaskSlotsErrorCode> {
  const window = checkPlacement(calendar, placement);
  if (!window.ok) {
    return window;
  }
  const firstHour = nextWorkingHour(calendar, placement.start);
  if (placement.durationHours === 0 || !firstHour.ok) {
    return firstHour.ok ? failure('INVALID_DURATION') : firstHour;
  }
  const firstDay = dayIndexOf(firstHour.value);
  const firstDayHours = firstDayHoursOfDay(
    calendar,
    firstHour.value,
    window.value,
    placement.durationHours,
  );
  const start = startOfDay(firstDay) + valueAt(firstDayHours, 0);
  const remaining = toQuarters(placement.durationHours) - firstDayHours.length;
  if (remaining === 0) {
    return success({
      start,
      end: startOfDay(firstDay) + valueAt(firstDayHours, firstDayHours.length - 1) + QUARTER_HOUR,
    });
  }
  const dailyQuarters = window.value.length;
  const extraDays = Math.ceil(remaining / dailyQuarters);
  const lastDay = workingDayAfter(calendar, firstDay, extraDays);
  if (lastDay === null) {
    return failure('BEYOND_PLANNING_HORIZON');
  }
  const lastDayQuarters = remaining - (extraDays - 1) * dailyQuarters;
  const lastQuarter = valueAt(window.value, lastDayQuarters - 1);
  return success({ start, end: startOfDay(lastDay) + lastQuarter + QUARTER_HOUR });
}

/** Checks the start and duration of a block and returns the start of the quarter hours of the day it works on after its first day. */
function checkPlacement(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
): Result<readonly number[], TaskSlotsErrorCode> {
  if (!isProjectHour(placement.start)) {
    return failure('INVALID_INSTANT');
  }
  if (!isValidDuration(placement.durationHours)) {
    return failure('INVALID_DURATION');
  }
  return computeDailyWindow(calendar, placement);
}

/** Tells whether a task duration is a whole, non-negative and supported number of quarter hours. */
function isValidDuration(durationHours: number): boolean {
  return (
    isQuarterHours(durationHours) && durationHours >= 0 && durationHours <= MAX_TASK_DURATION_HOURS
  );
}

/** Returns the start of the quarter hours of the day a task works on after its first day, or why its daily pattern does not fit the calendar. */
export function computeDailyWindow(
  calendar: CompiledCalendar,
  { hoursPerDay, dailyStartHour }: Pick<TaskPlacement, 'hoursPerDay' | 'dailyStartHour'>,
): Result<readonly number[], DailyWindowErrorCode> {
  const hoursPerWorkingDay = calendar.workingHoursPerDay;
  const taskHoursPerDay = hoursPerDay ?? hoursPerWorkingDay;
  const tooFew = hoursPerDay !== null && hoursPerDay < MIN_HOURS_PER_DAY;
  if (!isQuarterHours(taskHoursPerDay) || tooFew || taskHoursPerDay > hoursPerWorkingDay) {
    return failure('INVALID_HOURS_PER_DAY');
  }
  const firstHour = dailyStartHour ?? 0;
  if (!isQuarterHours(firstHour) || firstHour < 0 || firstHour >= HOURS_PER_DAY) {
    return failure('INVALID_DAILY_START_HOUR');
  }
  const quarters = toQuarters(taskHoursPerDay);
  const window = workingHoursFrom(calendar, firstHour).slice(0, quarters);
  return window.length === quarters ? success(window) : failure('INVALID_DAILY_START_HOUR');
}

/** Builds the time slots of a task, day after day, until its duration is used up. */
function collectTaskSlots(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
  window: readonly number[],
): Result<TimeSlot[], TaskSlotsErrorCode> {
  const firstHour = nextWorkingHour(calendar, placement.start);
  if (!firstHour.ok) {
    return firstHour;
  }
  const slots: TimeSlot[] = [];
  const firstDayHours = firstDayHoursOfDay(
    calendar,
    firstHour.value,
    window,
    placement.durationHours,
  );
  let day: DayIndex | null = dayIndexOf(firstHour.value);
  appendRanges(slots, startOfDay(day), toRanges(firstDayHours));
  let remaining = toQuarters(placement.durationHours) - firstDayHours.length;
  const fullDayRanges = toRanges(window);
  while (remaining > 0) {
    day = nextWorkingDay(calendar, day + 1);
    if (day === null) {
      return failure('BEYOND_PLANNING_HORIZON');
    }
    const ranges =
      remaining >= window.length ? fullDayRanges : toRanges(window.slice(0, remaining));
    appendRanges(slots, startOfDay(day), ranges);
    remaining -= Math.min(remaining, window.length);
  }
  return success(slots);
}

/** Lists the start of the quarter hours of the day worked on the first day, starting no earlier than the daily window. */
function firstDayHoursOfDay(
  calendar: CompiledCalendar,
  firstHour: ProjectHour,
  window: readonly number[],
  durationHours: number,
): number[] {
  const earliestHourOfDay = Math.max(hourOfDay(firstHour), valueAt(window, 0));
  return workingHoursFrom(calendar, earliestHourOfDay).slice(
    0,
    Math.min(window.length, toQuarters(durationHours)),
  );
}

/** Groups the sorted starts of quarter hours of the day into continuous ranges. */
function toRanges(quartersOfDay: readonly number[]): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const quarter of quartersOfDay) {
    const last = ranges.at(-1);
    if (last?.endHour === quarter) {
      ranges[ranges.length - 1] = { startHour: last.startHour, endHour: quarter + QUARTER_HOUR };
    } else {
      ranges.push({ startHour: quarter, endHour: quarter + QUARTER_HOUR });
    }
  }
  return ranges;
}

/** Appends the ranges of one day to the slots, extending the last slot when they touch. */
function appendRanges(
  slots: TimeSlot[],
  dayStart: ProjectHour,
  ranges: readonly TimeRange[],
): void {
  for (const range of ranges) {
    const start = dayStart + range.startHour;
    const end = dayStart + range.endHour;
    const last = slots.at(-1);
    if (last?.end === start) {
      slots[slots.length - 1] = { start: last.start, end };
    } else {
      slots.push({ start, end });
    }
  }
}
