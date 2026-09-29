import { DEFAULT_CALENDAR } from '../../calendar/default-calendar';
import { MAX_CSV_COLUMNS, MAX_CSV_TEXT_UTF16_UNITS, MAX_TASKS } from '../../limits';
import type { Project, Task, TaskId } from '../../model/project';
import { failure, success, type Result } from '../../result';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../scheduling/schedule-project';
import { dayIndexOf, startOfDay, type ProjectHour } from '../../time';
import { readProject, STORED_VALUE_CODEC } from '../../validation/read-project';
import type { ValidationIssue } from '../../validation/validation-issues';
import { stripLeadingByteOrderMark } from '../byte-order-mark';
import type { CsvColumn } from './csv-columns';
import { readTable, rowPath, type CsvWarning, type ParsedRow } from './csv-rows';
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
  const table = parseCsv(stripLeadingByteOrderMark(text), options.format.listSeparator, {
    maxColumns: MAX_CSV_COLUMNS,
    maxRows: MAX_TASKS,
  });
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

/** Schedules the project, then sets a "not before" constraint only on the tasks it would start before their table date, and schedules again when one was set. */
function constrainStarts(
  project: Project,
  plan: TaskPlan,
): Result<ScheduledProject, readonly ValidationIssue[]> {
  const rowsById = new Map(plan.tasks.map(({ task, row }) => [task.id, row]));
  const free = scheduleOrIssue(project, rowsById);
  if (!free.ok) {
    return free;
  }
  const tasks = project.tasks.map((task) =>
    withStartConstraint(task, rowsById.get(task.id)?.start ?? null, free.value),
  );
  if (tasks.every((task, index) => task === project.tasks[index])) {
    return success({ project, schedule: free.value });
  }
  const constrainedProject = { ...project, tasks };
  const schedule = scheduleOrIssue(constrainedProject, rowsById);
  return schedule.ok
    ? success({ project: constrainedProject, schedule: schedule.value })
    : schedule;
}

/** Adds the start date of a row to its task as a "not before" constraint when the free schedule starts the task earlier. */
function withStartConstraint(task: Task, start: CsvDate | null, schedule: Schedule): Task {
  if (task.kind === 'summary' || start === null) {
    return task;
  }
  const requested = startHourOf(start);
  const placement = schedule.placements.get(task.id);
  return placement !== undefined && placement.start < requested
    ? { ...task, startNoEarlierThan: requested }
    : task;
}

/** Schedules a project, turning a failure into an issue at the row of the task that could not be placed. */
function scheduleOrIssue(
  project: Project,
  rowsById: ReadonlyMap<TaskId, ParsedRow>,
): Result<Schedule, readonly ValidationIssue[]> {
  const schedule = scheduleProject(project);
  return schedule.ok ? schedule : failure([schedulingIssue(schedule.error, rowsById)]);
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
