import type { RegionalFormat } from '../../core/exchange/csv/regional-format';
import { formatRegionalDateTime } from '../../core/exchange/csv/regional-format';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
import { predecessorText } from './plan-outline';
import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { failure } from '../../core/result';
import { durationEditorText } from './durations';
import {
  renameTask,
  setDuration,
  setEnd,
  setPredecessors,
  setProgress,
  setStart,
  type Edit,
  type EditContext,
} from './task-commands';

export type EditableColumn = 'name' | 'duration' | 'start' | 'end' | 'progress' | 'predecessors';

export const EDITABLE_COLUMNS: readonly EditableColumn[] = [
  'name',
  'duration',
  'start',
  'end',
  'progress',
  'predecessors',
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
