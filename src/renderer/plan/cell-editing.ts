import type { RegionalFormat } from '../../core/exchange/csv/regional-format';
import { formatRegionalDateTime } from '../../core/exchange/csv/regional-format';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
import { predecessorText } from './plan-outline';
import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { formatDateTime, parseDateTime } from '../../core/civil-format';
import { failure } from '../../core/result';
import { MINUTES_PER_QUARTER, QUARTER_HOUR, type ProjectHour } from '../../core/time';
import { durationEditorText } from './durations';
import {
  renameTask,
  setDuration,
  setEnd,
  setPredecessors,
  setProgress,
  setTag,
  setStart,
  type Edit,
  type EditContext,
} from './task-commands';

const PICKER_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

export type EditableColumn =
  'name' | 'duration' | 'start' | 'end' | 'progress' | 'predecessors' | 'tag';

export const EDITABLE_COLUMNS: readonly EditableColumn[] = [
  'name',
  'duration',
  'start',
  'end',
  'progress',
  'predecessors',
  'tag',
];

export interface CellSource {
  readonly schedule: Schedule | null;
  readonly calendar: CompiledCalendar | null;
  readonly incoming: ReadonlyMap<TaskId, readonly Dependency[]>;
  readonly wbsById: ReadonlyMap<TaskId, string>;
  readonly format: RegionalFormat;
}

/** Tells whether a column of a task can be edited: every column of a work task or milestone, only the name of a summary. */
export function isEditable(task: Task, column: EditableColumn): boolean {
  return column === 'name' || task.kind !== 'summary';
}

/** Returns the text a cell editor starts with, written so that it reads back to the same value. */
export function editorText(task: Task, column: EditableColumn, source: CellSource): string {
  if (column === 'name' || task.kind === 'summary') {
    return task.name;
  }
  switch (column) {
    case 'duration':
      return durationEditorText(
        task.kind === 'task'
          ? task.segments.reduce((sum, segment) => sum + segment.durationHours, 0)
          : 0,
      );
    case 'start': {
      const placement = source.schedule?.placements.get(task.id);
      const start = task.startNoEarlierThan ?? placement?.start;
      return start === undefined ? '' : formatRegionalDateTime(start, source.format);
    }
    case 'end': {
      const end = source.schedule?.placements.get(task.id)?.end;
      return end === undefined ? '' : formatRegionalDateTime(end, source.format);
    }
    case 'progress':
      return String(task.progressPercent);
    case 'predecessors':
      return predecessorText(source.incoming.get(task.id), source.wbsById);
    case 'tag':
      return task.tagId ?? '';
  }
}

/** Builds the change a typed cell asks for. */
export function cellEdit(
  context: EditContext,
  id: TaskId,
  column: EditableColumn,
  text: string,
  source: CellSource,
): Edit {
  const { format } = source;
  switch (column) {
    case 'name':
      return renameTask(context, id, text);
    case 'duration':
      return setDuration(context, id, text);
    case 'start':
      return setStart(context, id, text, format);
    case 'end':
      return endEdit(context, id, text, source);
    case 'progress':
      return setProgress(context, id, text);
    case 'predecessors':
      return setPredecessors(context, id, text);
    case 'tag':
      return setTag(context, id, text === '' ? null : text);
  }
}

/** Returns the editable column next to another, staying at the first or last one. */
export function nextColumn(column: EditableColumn, step: -1 | 1): EditableColumn {
  const index = EDITABLE_COLUMNS.indexOf(column) + step;
  return EDITABLE_COLUMNS[Math.min(Math.max(index, 0), EDITABLE_COLUMNS.length - 1)] ?? column;
}

/** Builds the change a typed end asks for, which needs the schedule to know where the last block starts. */
function endEdit(context: EditContext, id: TaskId, text: string, source: CellSource): Edit {
  const lastBlock = source.schedule?.placements.get(id)?.segments.at(-1);
  if (lastBlock === undefined || source.calendar === null) {
    return failure('NOT_POSSIBLE');
  }
  return setEnd(context, id, text, source.format, {
    lastBlockStart: lastBlock.start,
    calendar: source.calendar,
  });
}

/** Writes an instant as the value of a date and time picker. */
export function pickerValue(hour: ProjectHour): string {
  return formatDateTime(hour);
}

/** Reads the value of a date and time picker, rounded to the nearest quarter hour, or null when it is empty or not a date. */
export function hourFromPicker(value: string): ProjectHour | null {
  const match = PICKER_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const [, date = '', hour = '', minute = ''] = match;
  const quarters = Math.round(Number(minute) / MINUTES_PER_QUARTER);
  const whole = parseDateTime(`${date}T${hour}:00`);
  return whole.ok ? whole.value + quarters * QUARTER_HOUR : null;
}
