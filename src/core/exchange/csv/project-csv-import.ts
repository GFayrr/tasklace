import { DEFAULT_CALENDAR } from '../../calendar/default-calendar';
import { MAX_CSV_COLUMNS, MAX_CSV_TEXT_UTF16_UNITS, MAX_TASKS } from '../../limits';
import type { Project, Task, TaskId } from '../../model/project';
import { failure, success, type Result } from '../../result';
import {
  scheduleWithRequestedStarts,
  type Schedule,
  type SchedulingFailure,
} from '../../scheduling/schedule-project';
import { dayIndexOf, startOfDay, type ProjectHour } from '../../time';
import { readProject, STORED_VALUE_CODEC } from '../../validation/read-project';
import type { ValidationIssue } from '../../validation/validation-issues';
import { stripLeadingByteOrderMark } from '../byte-order-mark';
import type { CsvColumn } from './csv-columns';
import {
  readTable,
  rowPath,
  selectKnownColumns,
  type CsvWarning,
  type ParsedRow,
} from './csv-rows';
import { planTasks, type PlannedTask, type TaskPlan } from './csv-task-plan';
import { parseCsv, type CsvSyntaxError } from './csv-text';
import type { CsvDate, RegionalFormat } from './regional-format';

export interface CsvImportOptions {
  readonly format: RegionalFormat;
  readonly projectName: string;
  readonly fallbackStart: ProjectHour;
}

export interface CsvImport {
  readonly project: Project;
  readonly schedule: Schedule;
  readonly warnings: readonly CsvWarning[];
}

interface ScheduledProject {
  readonly project: Project;
  readonly schedule: Schedule;
}

const DEFAULT_OPTIONS = {
  criticalPathEnabled: false,
  dateConstraintsEnabled: false,
  alwaysShowPatterns: false,
};
const LIST_PATH_PATTERN = /^(tasks|dependencies|tags)(?:\[(\d+)\](?:\.([A-Za-z]+))?)?(?![A-Za-z])/;
const DECIMAL_RADIX = 10;
const TASK_FIELD_COLUMNS: Readonly<Record<string, CsvColumn>> = {
  name: 'name',
  parentId: 'wbs',
  progressPercent: 'progress',
  tagId: 'tag',
  startNoEarlierThan: 'start',
};
const WHOLE_LIST_PATHS: Readonly<Record<string, string>> = {
  tasks: 'rows',
  dependencies: 'columns.predecessors',
  tags: 'columns.tag',
};

/** Reads a task table exported by a spreadsheet into a new project and its schedule, or lists the problems found at their row and column, with warnings about what was ignored or scheduled differently. */
export function importProjectCsv(
  text: string,
  options: CsvImportOptions,
): Result<CsvImport, readonly ValidationIssue[]> {
  if (text.length > MAX_CSV_TEXT_UTF16_UNITS) {
    return failure([{ path: '', code: 'TOO_LARGE' }]);
  }
  const limits = { maxColumns: MAX_CSV_COLUMNS, maxRows: MAX_TASKS };
  const separator = options.format.listSeparator;
  const table = parseCsv(stripLeadingByteOrderMark(text), separator, limits, selectKnownColumns);
  if (!table.ok) {
    return failure([syntaxIssue(table.error)]);
  }
  const parsed = readTable(table.value, options.format);
  if (!parsed.ok) {
    return parsed;
  }
  const warnings = [...parsed.value.warnings];
  const plan = planTasks(parsed.value.rows, warnings);
  if (!plan.ok) {
    return plan;
  }
  const project = readProject(
    projectData(plan.value, parsed.value.rows, options),
    STORED_VALUE_CODEC,
  );
  if (!project.ok) {
    return failure(project.error.map((issue) => relocateIssue(issue, plan.value)));
  }
  const scheduled = constrainStarts(project.value, plan.value);
  if (!scheduled.ok) {
    return scheduled;
  }
  warnings.push(...scheduleWarnings(plan.value, scheduled.value.schedule));
  return success({ ...scheduled.value, warnings });
}

/** Turns a syntax error of the text into an issue. */
function syntaxIssue(error: CsvSyntaxError): ValidationIssue {
  if (error.code === 'INVALID_CSV') {
    return { path: rowPath(error.rowNumber), code: 'INVALID_CSV' };
  }
  return { path: error.code === 'TOO_MANY_COLUMNS' ? 'columns' : 'rows', code: 'TOO_MANY_ITEMS' };
}

/** Builds the new project, still to be validated: default calendar and options, starting at the earliest start of the table, or at the fallback start when no row has one. */
function projectData(
  plan: TaskPlan,
  rows: readonly ParsedRow[],
  options: CsvImportOptions,
): Project {
  const starts = rows.flatMap((row) => (row.start === null ? [] : [startHourOf(row.start)]));
  return {
    name: options.projectName,
    startDate: starts.reduce(
      (earliest, start) => Math.min(earliest, start),
      starts[0] ?? options.fallbackStart,
    ),
    calendar: DEFAULT_CALENDAR,
    options: DEFAULT_OPTIONS,
    tags: plan.tags.map(({ item }) => item),
    tasks: plan.tasks.map(({ task }) => task),
    dependencies: plan.dependencies.map(({ item }) => item),
    baseline: null,
  };
}

/** Moves an issue found in the built project to the row and column it comes from, an issue about a whole list going to its column. */
function relocateIssue(issue: ValidationIssue, plan: TaskPlan): ValidationIssue {
  const match = LIST_PATH_PATTERN.exec(issue.path);
  if (match === null) {
    return issue;
  }
  const [, list = '', indexText, field] = match;
  if (indexText === undefined) {
    return { ...issue, path: WHOLE_LIST_PATHS[list] ?? issue.path };
  }
  const index = Number.parseInt(indexText, DECIMAL_RADIX);
  if (list === 'tasks') {
    const planned = plan.tasks[index];
    return { ...issue, path: planned === undefined ? issue.path : taskIssuePath(planned, field) };
  }
  const items = list === 'tags' ? plan.tags : plan.dependencies;
  const rowNumber = items[index]?.rowNumber;
  const column = list === 'tags' ? 'tag' : 'predecessors';
  return { ...issue, path: rowNumber === undefined ? issue.path : rowPath(rowNumber, column) };
}

/** Returns the cell a field of a task comes from, or the whole row for a field no single cell holds. */
function taskIssuePath(planned: PlannedTask, field: string | undefined): string {
  const { row } = planned;
  if (field === 'segments') {
    return rowPath(row.rowNumber, row.blocks === null ? 'duration' : 'blocks');
  }
  const column = field === undefined ? undefined : TASK_FIELD_COLUMNS[field];
  return rowPath(row.rowNumber, column);
}

/** Schedules the project once, the start date of each work task or milestone row becoming a "not before" constraint only where the task, placed after its predecessors, would otherwise start earlier. */
function constrainStarts(
  project: Project,
  plan: TaskPlan,
): Result<ScheduledProject, readonly ValidationIssue[]> {
  const rowsById = new Map(plan.tasks.map(({ task, row }) => [task.id, row]));
  const requestedStarts = new Map(
    plan.tasks.flatMap(({ task, row }) =>
      task.kind === 'summary' || row.start === null
        ? []
        : [[task.id, startHourOf(row.start)] as const],
    ),
  );
  const scheduled = scheduleWithRequestedStarts(project, requestedStarts);
  if (!scheduled.ok) {
    return failure([schedulingIssue(scheduled.error, rowsById)]);
  }
  const { schedule, keptStarts } = scheduled.value;
  const tasks = project.tasks.map((task) => withKeptStart(task, keptStarts.get(task.id)));
  return success({ project: { ...project, tasks }, schedule });
}

/** Gives a task the start date the schedule kept for it, if any. */
function withKeptStart(task: Task, start: ProjectHour | undefined): Task {
  return task.kind === 'summary' || start === undefined
    ? task
    : { ...task, startNoEarlierThan: start };
}

/** Turns a scheduling failure into an issue carrying the reason a task could not be placed, at its row. */
function schedulingIssue(
  error: SchedulingFailure,
  rowsById: ReadonlyMap<TaskId, ParsedRow>,
): ValidationIssue {
  if (error.kind !== 'task') {
    return { path: '', code: 'UNSCHEDULABLE' };
  }
  const row = rowsById.get(error.error.taskId);
  return { path: row === undefined ? '' : rowPath(row.rowNumber), code: error.error.code };
}

/** Warns about every start, end or summary progress of the table that the computed schedule does not follow. */
function scheduleWarnings(plan: TaskPlan, schedule: Schedule): CsvWarning[] {
  return plan.tasks.flatMap(({ row, task }) => {
    const summary = schedule.summaries.get(task.id);
    const dates = task.kind === 'summary' ? summary : schedule.placements.get(task.id);
    const warnings: CsvWarning[] = [];
    if (row.start !== null && !matchesDate(row.start, dates?.start ?? null, false)) {
      warnings.push({ path: rowPath(row.rowNumber, 'start'), code: 'START_DIFFERS' });
    }
    if (row.end !== null && !matchesDate(row.end, dates?.end ?? null, true)) {
      warnings.push({ path: rowPath(row.rowNumber, 'end'), code: 'END_DIFFERS' });
    }
    if (
      task.kind === 'summary' &&
      !matchesProgress(row.progressPercent, summary?.progressPercent ?? null)
    ) {
      warnings.push({ path: rowPath(row.rowNumber, 'progress'), code: 'PROGRESS_DIFFERS' });
    }
    return warnings;
  });
}

/** Tells whether the progress written for a summary matches the progress computed from its children, rounded as the export writes it. */
function matchesProgress(written: number | null, computed: number | null): boolean {
  return written === null || (computed !== null && written === Math.round(computed));
}

/** Tells whether a date of the table matches a computed instant, a date without hour matching its whole day and, for an end, an end at midnight after it. */
function matchesDate(date: CsvDate, hour: ProjectHour | null, isEnd: boolean): boolean {
  if (hour === null) {
    return false;
  }
  if (date.kind === 'dateTime') {
    return date.hour === hour;
  }
  return dayIndexOf(hour) === date.day || (isEnd && dayIndexOf(hour - 1) === date.day);
}

/** Returns the instant a date of the table starts at, midnight for a date without hour. */
function startHourOf(date: CsvDate): ProjectHour {
  return date.kind === 'dateTime' ? date.hour : startOfDay(date.day);
}
