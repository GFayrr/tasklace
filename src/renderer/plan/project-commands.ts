import { formatDate, parseDate, parseDateTime } from '../../core/civil-format';
import type { DayRange, TimeRange, WorkingCalendar } from '../../core/model/calendar';
import type { Baseline, ProjectOptions } from '../../core/model/project';

import { failure, success } from '../../core/result';
import type { SharedOperation } from '../../core/shared/shared-operations';
import { dayIndexOf, HOURS_PER_DAY, type Weekday } from '../../core/time';
import type { Edit, EditContext } from './task-commands';
import { formatTimeOfDay, parseTimeOfDay } from './time-of-day';

export type BooleanProjectOption = {
  [Key in keyof ProjectOptions]: ProjectOptions[Key] extends boolean ? Key : never;
}[keyof ProjectOptions];

/** A range of working hours as the time fields show it, "00:00" as an end meaning the end of the day. */
export interface TimeRangeText {
  readonly start: string;
  readonly end: string;
}

/** A period off as the date fields show it, an empty last day meaning a single day. */
export interface DayRangeText {
  readonly first: string;
  readonly last: string;
}

const ADDED_RANGE_HOURS = 1;
const ADDED_RANGE_GAP_HOURS = 1;
const NEXT_DAY = 1;

/** Renames the project, the shared session refusing an empty or too long name. */
export function renameProject(name: string): Edit {
  return success([{ type: 'updateProject', fields: { name } }]);
}

/** Moves the start of the project to a date and time typed as "YYYY-MM-DDTHH:MM", as a date and time field gives it. */
export function setProjectStart(text: string): Edit {
  const start = parseDateTime(text.trim());
  return start.ok
    ? success([{ type: 'updateProject', fields: { startDate: start.value } }])
    : failure('INVALID_DATE');
}

/** Makes a weekday a working day or a day off, keeping the working weekdays in order. */
export function setWorkingWeekday(context: EditContext, day: Weekday, worked: boolean): Edit {
  const others = context.project.calendar.workingWeekdays.filter((weekday) => weekday !== day);
  const workingWeekdays = worked ? [...others, day].sort((left, right) => left - right) : others;
  return calendarEdit(context, { workingWeekdays });
}

/** Changes the start and end of a range of working hours, both typed as "HH:MM" on a quarter hour, midnight as an end meaning the end of the day. */
export function setTimeRange(context: EditContext, index: number, text: TimeRangeText): Edit {
  const ranges = context.project.calendar.workingTimeRanges;
  if (!isIndexOf(ranges, index)) {
    return failure('NOT_POSSIBLE');
  }
  const startHour = parseTimeOfDay(text.start);
  const end = parseTimeOfDay(text.end);
  if (startHour === null || end === null) {
    return failure('INVALID_TIME');
  }
  const endHour = end === 0 ? HOURS_PER_DAY : end;
  const workingTimeRanges = ranges.map((range, position) =>
    position === index ? { startHour, endHour } : range,
  );
  return calendarEdit(context, { workingTimeRanges });
}

/** Adds a one-hour range of working hours an hour after the latest range ends, or at 01:00 without any, refusing when the day has no room left for it. */
export function addTimeRange(context: EditContext): Edit {
  const ranges = context.project.calendar.workingTimeRanges;
  const lastEnd = ranges.reduce((latest, range) => Math.max(latest, range.endHour), 0);
  const startHour = lastEnd + ADDED_RANGE_GAP_HOURS;
  const endHour = startHour + ADDED_RANGE_HOURS;
  if (endHour > HOURS_PER_DAY) {
    return failure('NO_ROOM_FOR_RANGE');
  }
  return calendarEdit(context, { workingTimeRanges: [...ranges, { startHour, endHour }] });
}

/** Removes a range of working hours. */
export function removeTimeRange(context: EditContext, index: number): Edit {
  const ranges = context.project.calendar.workingTimeRanges;
  return !isIndexOf(ranges, index)
    ? failure('NOT_POSSIBLE')
    : calendarEdit(context, {
        workingTimeRanges: ranges.filter((_, position) => position !== index),
      });
}

/** Changes the first and last day of a period off, typed as "YYYY-MM-DD", an empty last day meaning the first one. */
export function setNonWorkingPeriod(context: EditContext, index: number, text: DayRangeText): Edit {
  const periods = context.project.calendar.nonWorkingPeriods;
  if (!isIndexOf(periods, index)) {
    return failure('NOT_POSSIBLE');
  }
  const first = parseDate(text.first.trim());
  const last = text.last.trim() === '' ? first : parseDate(text.last.trim());
  if (!first.ok || !last.ok) {
    return failure('INVALID_DATE');
  }
  const nonWorkingPeriods = periods.map((period, position) =>
    position === index ? { firstDay: first.value, lastDay: last.value } : period,
  );
  return calendarEdit(context, { nonWorkingPeriods });
}

/** Adds a single day off: the day after the latest period off, or the first day of the project when there is none. */
export function addNonWorkingPeriod(context: EditContext): Edit {
  const periods = context.project.calendar.nonWorkingPeriods;
  const lastDay = periods.reduce((latest, period) => Math.max(latest, period.lastDay), -Infinity);
  const day = Number.isFinite(lastDay) ? lastDay + NEXT_DAY : dayIndexOf(context.project.startDate);
  return calendarEdit(context, {
    nonWorkingPeriods: [...periods, { firstDay: day, lastDay: day }],
  });
}

/** Removes a period off. */
export function removeNonWorkingPeriod(context: EditContext, index: number): Edit {
  const periods = context.project.calendar.nonWorkingPeriods;
  return !isIndexOf(periods, index)
    ? failure('NOT_POSSIBLE')
    : calendarEdit(context, {
        nonWorkingPeriods: periods.filter((_, position) => position !== index),
      });
}

/** Adds up the working hours of a day of a valid calendar, whose ranges never overlap. */
export function workingHoursOf(calendar: WorkingCalendar): number {
  return calendar.workingTimeRanges.reduce(
    (total, range) => total + range.endHour - range.startHour,
    0,
  );
}

/** Writes a range of working hours as the time fields show it. */
export function timeRangeText(range: TimeRange): TimeRangeText {
  return { start: formatTimeOfDay(range.startHour), end: formatTimeOfDay(range.endHour) };
}

/** Writes a period off as the date fields show it, a single day leaving the last field empty. */
export function dayRangeText(period: DayRange): DayRangeText {
  return {
    first: formatDate(period.firstDay),
    last: period.lastDay === period.firstDay ? '' : formatDate(period.lastDay),
  };
}

/** Tells whether a number is the position of an item of a list. */
function isIndexOf(list: readonly unknown[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length;
}

/** Builds the change of a part of the calendar, the rest of it kept as it is. */
function calendarEdit(context: EditContext, change: Partial<WorkingCalendar>): Edit {
  const calendar = { ...context.project.calendar, ...change };
  const operation: SharedOperation = { type: 'updateProject', fields: { calendar } };
  return success([operation]);
}

/** Turns an option of the project on when it is off and off when it is on, reading it in the project the change is built from, the rest of its options kept as they are. */
export function toggleProjectOption(context: EditContext, option: BooleanProjectOption): Edit {
  const options = { ...context.project.options, [option]: !context.project.options[option] };
  return success([{ type: 'updateProject', fields: { options } }]);
}

/** Replaces the baseline of the project with a newly taken one. */
export function setBaseline(baseline: Baseline): Edit {
  return success([{ type: 'updateProject', fields: { baseline } }]);
}

/** Removes the baseline of the project. */
export function clearBaseline(): Edit {
  return success([{ type: 'updateProject', fields: { baseline: null } }]);
}
