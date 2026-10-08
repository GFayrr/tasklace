import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import type { WorkingCalendar } from '../model/calendar';
import {
  dayIndexOf,
  fromProjectHour,
  toProjectHour,
  type DayIndex,
  type ProjectHour,
} from '../time';

/** Builds a project hour from a date and an hour, failing the test on invalid input. */
export function at(year: number, month: number, day: number, hour = 0): ProjectHour {
  const result = toProjectHour({ year, month, day, hour });
  if (!result.ok) {
    throw new Error(`Invalid test date ${String(year)}-${String(month)}-${String(day)}`);
  }
  return result.value;
}

/** Builds the day index of a date, failing the test on invalid input. */
export function dayOf(year: number, month: number, day: number): DayIndex {
  return dayIndexOf(at(year, month, day));
}

/** Formats a project hour as "YYYY-MM-DD HH:00" to make assertions readable. */
export function format(hour: ProjectHour): string {
  const { year, month, day, hour: hourOfDay } = fromProjectHour(hour);
  /** Writes a number on two digits. */
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(year)}-${pad(month)}-${pad(day)} ${pad(hourOfDay)}:00`;
}

/** Compiles a calendar, failing the test when it is invalid. */
export function compileOrThrow(calendar: WorkingCalendar): CompiledCalendar {
  const result = compileCalendar(calendar);
  if (!result.ok) {
    throw new Error(`Invalid test calendar: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
