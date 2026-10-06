import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { countWorkingHours } from '../../core/calendar/working-time';
import type { Task } from '../../core/model/project';
import type { TaskFloat } from '../../core/scheduling/backward-pass';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { Messages } from '../i18n/messages';
import { formatDuration } from './durations';
import { formatTableDateTime } from './table-dates';

export interface TaskCells {
  readonly duration: string;
  readonly start: string;
  readonly end: string;
  readonly progress: string;
}

export interface TableFormatters {
  readonly number: (value: number) => string;
  readonly percent: (percent: number) => string;
}

export interface FloatCells {
  readonly total: string;
  readonly free: string;
  readonly isCritical: boolean;
  readonly isUnknown: boolean;
}

const PERCENT = 100;
const EMPTY_CELLS: TaskCells = { duration: '', start: '', end: '', progress: '' };
const NO_FLOAT: FloatCells = { total: '', free: '', isCritical: false, isUnknown: false };
const UNKNOWN_FLOAT = '?';
const MINUS_SIGN = '\u2212';

/** Creates the number formatters of the task table in the regional format, dates being always written in ISO form. */
export function createTableFormatters(locale: string): TableFormatters {
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return {
    number: (value) => number.format(value),
    percent: (value) => percent.format(value / PERCENT),
  };
}

/** Writes the duration, dates and progress of a task as the table shows them, dates staying empty until the schedule is known. */
export function taskCells(
  task: Task,
  schedule: Schedule | null,
  calendar: CompiledCalendar | null,
  formatters: TableFormatters,
  messages: Messages,
): TaskCells {
  const hours = (count: number) => formatDuration(count, messages, formatters.number);
  if (task.kind === 'summary') {
    const dates = schedule?.summaries.get(task.id);
    if (dates?.start == null) {
      return EMPTY_CELLS;
    }
    const worked = calendar === null ? null : countWorkingHours(calendar, dates.start, dates.end);
    return {
      duration: worked?.ok === true ? hours(worked.value) : '',
      start: formatTableDateTime(dates.start),
      end: formatTableDateTime(dates.end),
      progress: formatters.percent(Math.round(dates.progressPercent)),
    };
  }
  const duration =
    task.kind === 'task'
      ? task.segments.reduce((sum, segment) => sum + segment.durationHours, 0)
      : 0;
  const placement = schedule?.placements.get(task.id);
  return {
    duration: hours(duration),
    start: placement === undefined ? '' : formatTableDateTime(placement.start),
    end: placement === undefined ? '' : formatTableDateTime(placement.end),
    progress: formatters.percent(task.progressPercent),
  };
}

/** Writes the total and free floats of a task as the table shows them, a negative float with a minus sign and an unknown float as a question mark, nothing for a task without floats. */
export function floatCells(
  taskFloat: TaskFloat | undefined,
  formatters: TableFormatters,
  messages: Messages,
): FloatCells {
  if (taskFloat === undefined) {
    return NO_FLOAT;
  }
  const hours = (count: number | null) => signedHours(count, formatters, messages);
  return {
    total: hours(taskFloat.totalFloatHours),
    free: hours(taskFloat.freeFloatHours),
    isCritical: taskFloat.isCritical,
    isUnknown: taskFloat.totalFloatHours === null,
  };
}

/** Writes a number of hours with a minus sign when negative, or a question mark when unknown. */
function signedHours(
  hours: number | null,
  formatters: TableFormatters,
  messages: Messages,
): string {
  if (hours === null) {
    return UNKNOWN_FLOAT;
  }
  const written = formatDuration(Math.abs(hours), messages, formatters.number);
  return hours < 0 ? `${MINUS_SIGN}${written}` : written;
}
