import { MAX_TASK_DURATION_HOURS } from '../limits';
import type { TimeRange } from '../model/calendar';
import { failure, success, type Result } from '../result';
import {
  HOURS_PER_DAY,
  dayIndexOf,
  hourOfDay,
  isProjectHour,
  startOfDay,
  type DayIndex,
  type ProjectHour,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';
import {
  nextWorkingDay,
  nextWorkingHour,
  workingHoursFrom,
  type WorkingTimeErrorCode,
} from './working-time';

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

/** Computes the exact working time slots a task occupies, from its start to its last hour. */
export function computeTaskSlots(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
): Result<TimeSlot[], TaskSlotsErrorCode> {
  if (!isProjectHour(placement.start)) {
    return failure('INVALID_INSTANT');
  }
  if (!isValidDuration(placement.durationHours)) {
    return failure('INVALID_DURATION');
  }
  const window = computeDailyWindow(calendar, placement);
  if (!window.ok) {
    return window;
  }
  if (placement.durationHours === 0) {
    return success([]);
  }
  return collectTaskSlots(calendar, placement, window.value);
}

/** Tells whether a task duration is a whole, non-negative and supported number of hours. */
function isValidDuration(durationHours: number): boolean {
  return (
    Number.isInteger(durationHours) &&
    durationHours >= 0 &&
    durationHours <= MAX_TASK_DURATION_HOURS
  );
}

/** Returns the hours of the day a task works on after its first day, or why its daily pattern does not fit the calendar. */
export function computeDailyWindow(
  calendar: CompiledCalendar,
  { hoursPerDay, dailyStartHour }: Pick<TaskPlacement, 'hoursPerDay' | 'dailyStartHour'>,
): Result<readonly number[], DailyWindowErrorCode> {
  const hoursPerWorkingDay = calendar.workingHoursOfDay.length;
  const taskHoursPerDay = hoursPerDay ?? hoursPerWorkingDay;
  if (
    !Number.isInteger(taskHoursPerDay) ||
    taskHoursPerDay < 1 ||
    taskHoursPerDay > hoursPerWorkingDay
  ) {
    return failure('INVALID_HOURS_PER_DAY');
  }
  const firstHour = dailyStartHour ?? 0;
  if (!Number.isInteger(firstHour) || firstHour < 0 || firstHour >= HOURS_PER_DAY) {
    return failure('INVALID_DAILY_START_HOUR');
  }
  const window = workingHoursFrom(calendar, firstHour).slice(0, taskHoursPerDay);
  return window.length === taskHoursPerDay ? success(window) : failure('INVALID_DAILY_START_HOUR');
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
  let remaining = placement.durationHours - firstDayHours.length;
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

/** Lists the hours of the day worked on the first day, starting no earlier than the daily window. */
function firstDayHoursOfDay(
  calendar: CompiledCalendar,
  firstHour: ProjectHour,
  window: readonly number[],
  durationHours: number,
): number[] {
  const earliestHourOfDay = Math.max(hourOfDay(firstHour), window[0] ?? 0);
  return workingHoursFrom(calendar, earliestHourOfDay).slice(
    0,
    Math.min(window.length, durationHours),
  );
}

/** Groups sorted hours of the day into continuous ranges. */
function toRanges(hoursOfDay: readonly number[]): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const hour of hoursOfDay) {
    const last = ranges.at(-1);
    if (last?.endHour === hour) {
      ranges[ranges.length - 1] = { startHour: last.startHour, endHour: hour + 1 };
    } else {
      ranges.push({ startHour: hour, endHour: hour + 1 });
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
