import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { countWorkingHours } from '../../core/calendar/working-time';
import type { Task } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { ProjectHour } from '../../core/time';
import { fillMessage, type Messages } from '../i18n/messages';

export interface TaskCells {
  readonly duration: string;
  readonly start: string;
  readonly end: string;
  readonly progress: string;
}

export interface TableFormatters {
  readonly dateTime: (hour: ProjectHour) => string;
  readonly number: (value: number) => string;
  readonly percent: (percent: number) => string;
}

const MILLISECONDS_PER_HOUR = 3_600_000;
const PERCENT = 100;
const EMPTY_CELLS: TaskCells = { duration: '', start: '', end: '', progress: '' };

/** Creates the formatters of the task table in the regional format, project hours being wall-clock times without time zone. */
export function createTableFormatters(locale: string): TableFormatters {
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return {
    dateTime: (hour) => dateTime.format(new Date(hour * MILLISECONDS_PER_HOUR)),
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
  const hours = (count: number) =>
    fillMessage(messages.table.hours, { count: formatters.number(count) });
  if (task.kind === 'summary') {
    const dates = schedule?.summaries.get(task.id);
    if (dates?.start == null || dates.end == null) {
      return EMPTY_CELLS;
    }
    const worked = calendar === null ? null : countWorkingHours(calendar, dates.start, dates.end);
    return {
      duration: worked?.ok === true ? hours(worked.value) : '',
      start: formatters.dateTime(dates.start),
      end: formatters.dateTime(dates.end),
      progress:
        dates.progressPercent === null ? '' : formatters.percent(Math.round(dates.progressPercent)),
    };
  }
  const duration =
    task.kind === 'task'
      ? task.segments.reduce((sum, segment) => sum + segment.durationHours, 0)
      : 0;
  const placement = schedule?.placements.get(task.id);
  return {
    duration: hours(duration),
    start: placement === undefined ? '' : formatters.dateTime(placement.start),
    end: placement === undefined ? '' : formatters.dateTime(placement.end),
    progress: formatters.percent(task.progressPercent),
  };
}
