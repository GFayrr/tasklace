import type { Dependency, Project, Task, TaskId } from '../../model/project';
import type { Schedule } from '../../scheduling/schedule-project';
import { failure, success, type Result } from '../../result';
import type { ProjectHour } from '../../time';
import { neutralizeFormula } from './csv-cells';
import { CSV_COLUMN_ORDER, CSV_HEADERS } from './csv-columns';
import { writeCsv } from './csv-text';
import {
  createDateTimeFormatter,
  decimalMarkOf,
  type DateTimeFormatter,
  type RegionalFormat,
} from './regional-format';
import {
  compareWbsNumbers,
  formatBlocks,
  formatPredecessors,
  type PredecessorReference,
} from './task-notations';

export const CSV_BYTE_ORDER_MARK = '﻿';

interface ExportContext {
  readonly schedule: Schedule;
  readonly formatDateTime: DateTimeFormatter;
  readonly tagNames: ReadonlyMap<string, string>;
  readonly predecessors: ReadonlyMap<TaskId, readonly PredecessorReference[]>;
  readonly decimalMark: string;
}

/** Writes the task table of a scheduled project as CSV for spreadsheets, in WBS order, with a byte order mark so that Excel reads accents correctly, refusing a schedule that does not cover every task of the project. */
export function exportProjectCsv(
  project: Project,
  schedule: Schedule,
  format: RegionalFormat,
): Result<string, 'SCHEDULE_MISMATCH'> {
  if (!coversEveryTask(project, schedule)) {
    return failure('SCHEDULE_MISMATCH');
  }
  const context: ExportContext = {
    schedule,
    formatDateTime: createDateTimeFormatter(format),
    tagNames: new Map(project.tags.map((tag) => [tag.id, tag.name])),
    predecessors: groupPredecessors(project.dependencies, schedule.wbsNumbers),
    decimalMark: decimalMarkOf(format),
  };
  const tasks = [...project.tasks].sort((left, right) =>
    compareWbsNumbers(wbsOf(left.id, schedule), wbsOf(right.id, schedule)),
  );
  const records = [
    CSV_COLUMN_ORDER.map((column) => CSV_HEADERS[column]),
    ...tasks.map((task) => taskCells(task, context)),
  ];
  const cells = records.map((record) => record.map(neutralizeFormula));
  return success(CSV_BYTE_ORDER_MARK + writeCsv(cells, format.listSeparator));
}

/** Tells whether a schedule numbers and dates every task of a project, as a schedule computed from an older version of it may not. */
function coversEveryTask(project: Project, schedule: Schedule): boolean {
  return project.tasks.every((task) => {
    const dates = task.kind === 'summary' ? schedule.summaries : schedule.placements;
    return schedule.wbsNumbers.has(task.id) && dates.has(task.id);
  });
}

/** Lists the predecessors of each task by WBS number, in WBS order. */
function groupPredecessors(
  dependencies: readonly Dependency[],
  wbsNumbers: ReadonlyMap<TaskId, string>,
): Map<TaskId, PredecessorReference[]> {
  const grouped = new Map<TaskId, PredecessorReference[]>();
  for (const dependency of dependencies) {
    const references = grouped.get(dependency.successorId) ?? [];
    references.push({
      wbs: wbsNumbers.get(dependency.predecessorId) ?? '',
      type: dependency.type,
      lagHours: dependency.lagHours,
    });
    grouped.set(dependency.successorId, references);
  }
  grouped.forEach((references) => {
    references.sort((left, right) => compareWbsNumbers(left.wbs, right.wbs));
  });
  return grouped;
}

/** Writes the cells of one task in the order of the columns. */
function taskCells(task: Task, context: ExportContext): string[] {
  const cells =
    task.kind === 'summary' ? summaryCells(task.id, context) : datedTaskCells(task, context);
  const byColumn = {
    ...cells,
    wbs: wbsOf(task.id, context.schedule),
    name: task.name,
    predecessors: formatPredecessors(context.predecessors.get(task.id) ?? []),
  };
  return CSV_COLUMN_ORDER.map((column) => byColumn[column]);
}

/** Writes the computed dates and progress of a summary task, its other cells staying empty. */
function summaryCells(id: TaskId, context: ExportContext) {
  const summary = context.schedule.summaries.get(id);
  return {
    start: formatDate(summary?.start ?? null, context),
    end: formatDate(summary?.end ?? null, context),
    duration: '',
    progress: formatProgress(summary?.progressPercent ?? null),
    tag: '',
    blocks: '',
  };
}

/** Writes the dates, duration, progress, tag and blocks of a work task or a milestone. */
function datedTaskCells(task: Exclude<Task, { kind: 'summary' }>, context: ExportContext) {
  const placement = context.schedule.placements.get(task.id);
  const segments = task.kind === 'task' ? task.segments : [];
  return {
    start: formatDate(placement?.start ?? null, context),
    end: formatDate(placement?.end ?? null, context),
    duration: formatHours(
      segments.reduce((total, segment) => total + segment.durationHours, 0),
      context.decimalMark,
    ),
    progress: String(task.progressPercent),
    tag: task.tagId === null ? '' : (context.tagNames.get(task.tagId) ?? ''),
    blocks: segments.length > 1 ? formatBlocks(segments) : '',
  };
}

/** Writes a number of hours with the decimal mark of the region, so that spreadsheets read it as a number. */
function formatHours(hours: number, decimalMark: string): string {
  return String(hours).replace('.', decimalMark);
}

/** Writes a progress as a whole percentage, an unknown progress staying empty. */
function formatProgress(percent: number | null): string {
  return percent === null ? '' : String(Math.round(percent));
}

/** Writes a date in the regional format, an unknown date staying empty. */
function formatDate(hour: ProjectHour | null, context: ExportContext): string {
  return hour === null ? '' : context.formatDateTime(hour);
}

/** Returns the WBS number of a task. */
function wbsOf(id: TaskId, schedule: Schedule): string {
  return schedule.wbsNumbers.get(id) ?? '';
}
