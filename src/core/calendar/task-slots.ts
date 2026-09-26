import { MAX_TASK_DURATION_HOURS } from '../limits';
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

export type TaskSlotsErrorCode =
  WorkingTimeErrorCode | 'INVALID_DURATION' | 'INVALID_HOURS_PER_DAY' | 'INVALID_DAILY_START_HOUR';

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
  const hours = collectTaskHours(calendar, placement, window.value);
  return hours.ok ? success(mergeHoursIntoSlots(hours.value)) : hours;
}

/** Tells whether a task duration is a whole, non-negative and supported number of hours. */
function isValidDuration(durationHours: number): boolean {
  return (
    Number.isInteger(durationHours) &&
    durationHours >= 0 &&
    durationHours <= MAX_TASK_DURATION_HOURS
  );
}

/** Returns the hours of the day a task works on after its first day. */
function computeDailyWindow(
  calendar: CompiledCalendar,
  { hoursPerDay, dailyStartHour }: TaskPlacement,
): Result<readonly number[], TaskSlotsErrorCode> {
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

/** Lists every project hour worked by a task, day after day, until its duration is used up. */
function collectTaskHours(
  calendar: CompiledCalendar,
  placement: TaskPlacement,
  window: readonly number[],
): Result<ProjectHour[], TaskSlotsErrorCode> {
  const firstHour = nextWorkingHour(calendar, placement.start);
  if (!firstHour.ok) {
    return firstHour;
  }
  const hours = collectFirstDayHours(calendar, firstHour.value, window, placement.durationHours);
  let day: DayIndex | null = dayIndexOf(firstHour.value);
  while (hours.length < placement.durationHours) {
    day = nextWorkingDay(calendar, day + 1);
    if (day === null) {
      return failure('BEYOND_PLANNING_HORIZON');
    }
    const dayStart = startOfDay(day);
    const remaining = placement.durationHours - hours.length;
    hours.push(...window.slice(0, remaining).map((hour) => dayStart + hour));
  }
  return success(hours);
}

/** Lists the hours worked on the first day, starting no earlier than the daily window. */
function collectFirstDayHours(
  calendar: CompiledCalendar,
  firstHour: ProjectHour,
  window: readonly number[],
  durationHours: number,
): ProjectHour[] {
  const dayStart = startOfDay(dayIndexOf(firstHour));
  const earliestHourOfDay = Math.max(hourOfDay(firstHour), window[0] ?? 0);
  const hoursOnFirstDay = Math.min(window.length, durationHours);
  return workingHoursFrom(calendar, earliestHourOfDay)
    .slice(0, hoursOnFirstDay)
    .map((hour) => dayStart + hour);
}

/** Groups consecutive project hours into continuous time slots. */
function mergeHoursIntoSlots(hours: readonly ProjectHour[]): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const hour of hours) {
    const last = slots.at(-1);
    if (last?.end === hour) {
      slots[slots.length - 1] = { start: last.start, end: hour + 1 };
    } else {
      slots.push({ start: hour, end: hour + 1 });
    }
  }
  return slots;
}
