import type { CompiledCalendar } from '../calendar/compile-calendar';
import { countWorkingHours, type WorkingTimeErrorCode } from '../calendar/working-time';
import { success, type Result } from '../result';
import type { ProjectHour } from '../time';

const STEPS_PER_DAY = 4;

/** Returns how many working days a task now ends after (positive) or before (negative) the end it had in the baseline, counted with the working days of the calendar and rounded to the quarter of a day, any gap of working time showing as at least a quarter of a day. */
export function endVarianceDays(
  calendar: CompiledCalendar,
  frozenEnd: ProjectHour,
  currentEnd: ProjectHour,
): Result<number, WorkingTimeErrorCode> {
  const late = currentEnd >= frozenEnd;
  const hours = late
    ? countWorkingHours(calendar, frozenEnd, currentEnd)
    : countWorkingHours(calendar, currentEnd, frozenEnd);
  if (!hours.ok) {
    return hours;
  }
  if (hours.value === 0) {
    return success(0);
  }
  const days = hours.value / calendar.workingHoursPerDay;
  const rounded = Math.max(Math.round(days * STEPS_PER_DAY), 1) / STEPS_PER_DAY;
  return success(late ? rounded : -rounded);
}
