import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { countWorkingHours } from '../../core/calendar/working-time';
import { endVarianceDays } from '../../core/baseline/end-variance';
import type { BaselineEntry, Task, TaskId } from '../../core/model/project';
import type { TaskFloat } from '../../core/scheduling/backward-pass';
import type { SchedulingConflictCode } from '../../core/scheduling/forward-pass';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { ProjectHour } from '../../core/time';
import { fillMessage, type Messages } from '../i18n/messages';
import type { DateConflictLine } from './conflict-lines';
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

export type VarianceKind =
  'behind' | 'ahead' | 'onTime' | 'notInBaseline' | 'noDates' | 'unknown' | 'pending';

export interface VarianceCell {
  readonly text: string;
  readonly kind: VarianceKind;
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
const SENTENCE_SEPARATOR = ' ';
const PLUS_SIGN = '+';
const NO_VARIANCE = '\u2014';
const VARIANCE_SIGNS = {
  behind: PLUS_SIGN,
  ahead: MINUS_SIGN,
  onTime: '',
} as const satisfies Record<'behind' | 'ahead' | 'onTime', string>;
const UNKNOWN_VARIANCE = '?';
const PENDING_VARIANCE: VarianceCell = { text: '', kind: 'pending' };

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
  /** Writes a number of hours as a duration. */
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
  /** Writes a float in hours with its sign, or nothing for an unknown float. */
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

/** Writes, for each task that does not meet one of its dates, the tooltip of its end cell naming every date it misses, with the dates in the regional format. */
export function dateConflictTitles(
  lines: readonly DateConflictLine[],
  messages: Messages,
  formatMoment: (hour: ProjectHour) => string,
): ReadonlyMap<TaskId, string> {
  const sentences: Record<SchedulingConflictCode, string> = {
    DEADLINE_MISSED: messages.table.deadlineMissed,
    MUST_FINISH_ON_NOT_MET: messages.table.mustFinishOnNotMet,
  };
  const titles = new Map<TaskId, string>();
  for (const { conflict, end, date } of lines) {
    const sentence = fillMessage(sentences[conflict.code], {
      date: formatMoment(date),
      end: formatMoment(end),
    });
    const previous = titles.get(conflict.taskId);
    titles.set(
      conflict.taskId,
      previous === undefined ? sentence : `${previous}${SENTENCE_SEPARATOR}${sentence}`,
    );
  }
  return titles;
}

/** Writes how many working days a task now ends after (+) or before (−) its end in the baseline, a dash for a task the baseline lacks or a summary without dates, nothing until its end is known and a question mark when the gap cannot be counted. */
export function varianceCell(
  task: Task,
  entry: BaselineEntry | undefined,
  schedule: Schedule | null,
  calendar: CompiledCalendar | null,
  formatters: TableFormatters,
  messages: Messages,
): VarianceCell {
  if (entry === undefined) {
    return { text: NO_VARIANCE, kind: 'notInBaseline' };
  }
  const end = scheduledEnd(task, schedule);
  if (end === 'pending' || end === 'noDates') {
    return end === 'pending' ? PENDING_VARIANCE : { text: NO_VARIANCE, kind: 'noDates' };
  }
  const days = calendar === null ? null : endVarianceDays(calendar, entry.end, end);
  if (days?.ok !== true) {
    return { text: UNKNOWN_VARIANCE, kind: 'unknown' };
  }
  const kind = days.value > 0 ? 'behind' : days.value < 0 ? 'ahead' : 'onTime';
  const text = fillMessage(messages.table.varianceDays, {
    days: `${VARIANCE_SIGNS[kind]}${formatters.number(Math.abs(days.value))}`,
  });
  return { text, kind };
}

/** Returns the end a task has in a schedule, the end of its children for a summary, 'noDates' for a summary without any, or 'pending' while the schedule does not know the task. */
function scheduledEnd(task: Task, schedule: Schedule | null): ProjectHour | 'noDates' | 'pending' {
  if (task.kind !== 'summary') {
    return schedule?.placements.get(task.id)?.end ?? 'pending';
  }
  const dates = schedule?.summaries.get(task.id);
  if (dates === undefined) {
    return 'pending';
  }
  return dates.end ?? 'noDates';
}
