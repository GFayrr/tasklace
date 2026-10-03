import type { Dependency, Tag, Task, TaskSegment } from '../../model/project';
import { failure, success, type Result } from '../../result';
import { shortestLink } from '../../scheduling/block-links';
import { spreadKeys } from '../../shared/fractional-index';
import { nextPaletteColor } from '../../tags/tag-palette';
import {
  createIssueList,
  type IssueList,
  type ValidationIssue,
} from '../../validation/validation-issues';
import type { CsvColumn } from './csv-columns';
import { rowPath, type CsvWarning, type ParsedRow } from './csv-rows';
import {
  compareWbsNumbers,
  parentWbsNumber,
  type PredecessorReference,
  type WbsNumber,
} from './task-notations';

export interface PlannedTask {
  readonly row: ParsedRow;
  readonly task: Task;
}

export interface PlannedItem<T> {
  readonly item: T;
  readonly rowNumber: number;
  readonly column: CsvColumn;
}

export interface TaskPlan {
  readonly tasks: readonly PlannedTask[];
  readonly dependencies: readonly PlannedItem<Dependency>[];
  readonly tags: readonly PlannedItem<Tag>[];
}

interface NumberedRow {
  readonly row: ParsedRow;
  readonly wbs: WbsNumber;
  readonly id: string;
}

interface Hierarchy {
  readonly numbered: readonly NumberedRow[];
  readonly idByWbs: ReadonlyMap<WbsNumber, string>;
  readonly parents: ReadonlySet<WbsNumber | null>;
}

interface TaskLinks {
  readonly parentId: string | null;
  readonly sortKey: string;
  readonly tagId: string | null;
}

type PlannedKind = Task['kind'];

const TASK_ID_PREFIX = 'task-';
const DEPENDENCY_ID_PREFIX = 'dependency-';
const TAG_ID_PREFIX = 'tag-';
const PREDECESSORS: CsvColumn = 'predecessors';
const BLOCKS: CsvColumn = 'blocks';

/** Turns parsed rows into the tasks, dependencies and tags of a new project, ordered by WBS number, or lists what cannot be resolved at its row. */
export function planTasks(
  rows: readonly ParsedRow[],
  warnings: CsvWarning[],
): Result<TaskPlan, readonly ValidationIssue[]> {
  const issues = createIssueList();
  const hierarchy = resolveHierarchy(rows, issues);
  if (hierarchy === null) {
    return failure(issues.issues);
  }
  const sortKeys = sortKeysByWbs(hierarchy.numbered);
  const tags: PlannedItem<Tag>[] = [];
  const tagIdByName = new Map<string, string>();
  const tasks = hierarchy.numbered.map((numbered) => {
    const kind = kindOf(numbered.row, hierarchy.parents.has(numbered.wbs), issues, warnings);
    const links = {
      parentId: parentIdOf(numbered, hierarchy.idByWbs, issues),
      sortKey: sortKeys.get(numbered.id) ?? '',
      tagId: kind === 'summary' ? null : tagIdOf(numbered.row, tags, tagIdByName),
    };
    return { row: numbered.row, task: taskOf(numbered, kind, links) };
  });
  const summaryIds = new Set(
    tasks.flatMap(({ task }) => (task.kind === 'summary' ? [task.id] : [])),
  );
  const taskById = new Map(tasks.map(({ task }) => [task.id, task]));
  const dependencies = planDependencies(hierarchy, summaryIds, issues).map((planned) =>
    shortened(planned, taskById),
  );
  return issues.issues.length > 0 ? failure(issues.issues) : success({ tasks, dependencies, tags });
}

/** Numbers every row from the WBS column when any row fills it, or by position when none does, refusing missing and repeated numbers. */
function resolveHierarchy(rows: readonly ParsedRow[], issues: IssueList): Hierarchy | null {
  const hasWbs = rows.some((row) => row.wbs !== null);
  const numbered: NumberedRow[] = [];
  const idByWbs = new Map<WbsNumber, string>();
  rows.forEach((row, index) => {
    const wbs = hasWbs ? row.wbs : String(index + 1);
    const id = `${TASK_ID_PREFIX}${String(index + 1)}`;
    if (wbs === null) {
      issues.add(rowPath(row.rowNumber, 'wbs'), 'MISSING_FIELD');
    } else if (idByWbs.has(wbs)) {
      issues.add(rowPath(row.rowNumber, 'wbs'), 'DUPLICATE_ENTRY');
    } else {
      idByWbs.set(wbs, id);
      numbered.push({ row, wbs, id });
    }
  });
  if (issues.issues.length > 0) {
    return null;
  }
  const parents = new Set(numbered.map(({ wbs }) => parentWbsNumber(wbs)));
  return { numbered, idByWbs, parents };
}

/** Gives every task a sort key following its WBS number, so that siblings keep the order the table numbers them in. */
function sortKeysByWbs(numbered: readonly NumberedRow[]): Map<string, string> {
  const ranked = [...numbered].sort((left, right) => compareWbsNumbers(left.wbs, right.wbs));
  const keys = spreadKeys(ranked.length);
  return new Map(ranked.map(({ id }, index) => [id, keys[index] ?? '']));
}

/** Decides whether a row is a summary, a milestone or a work task, a row with only a name and a WBS number being an empty summary, and reports values that do not fit that kind. */
function kindOf(
  row: ParsedRow,
  hasChildren: boolean,
  issues: IssueList,
  warnings: CsvWarning[],
): PlannedKind {
  if (hasChildren) {
    warnIgnoredSummaryValues(row, warnings);
    return 'summary';
  }
  if (row.blocks !== null) {
    checkBlocksMatchDuration(row, row.blocks, issues);
    return 'task';
  }
  if (row.durationHours === null) {
    return isHeading(row) ? 'summary' : missingDuration(row, issues);
  }
  return row.durationHours === 0 ? 'milestone' : 'task';
}

/** Tells whether a row holds nothing but a name and a WBS number, as a section title does, and so stands for a summary without tasks. */
function isHeading(row: ParsedRow): boolean {
  const values = [row.start, row.end, row.progressPercent, row.tagName];
  return values.every((value) => value === null) && row.predecessors.length === 0;
}

/** Reports a work task without duration. */
function missingDuration(row: ParsedRow, issues: IssueList): PlannedKind {
  issues.add(rowPath(row.rowNumber, 'duration'), 'MISSING_FIELD');
  return 'task';
}

/** Warns about a duration, tag or blocks given to a summary, whose values all come from its children, and about the links its blocks would wait for. */
function warnIgnoredSummaryValues(row: ParsedRow, warnings: CsvWarning[]): void {
  const ignored = [
    { column: 'duration', value: row.durationHours },
    { column: 'tag', value: row.tagName },
    { column: 'blocks', value: row.blocks },
  ] as const;
  ignored
    .filter(({ value }) => value !== null)
    .forEach(({ column }) => {
      warnings.push({ path: rowPath(row.rowNumber, column), code: 'IGNORED_VALUE' });
    });
  if (row.blockWaits.length > 0) {
    warnings.push({ path: rowPath(row.rowNumber, 'blocks'), code: 'IGNORED_LINKS' });
  }
}

/** Refuses blocks whose total differs from the duration given beside them. */
function checkBlocksMatchDuration(
  row: ParsedRow,
  blocks: readonly TaskSegment[],
  issues: IssueList,
): void {
  const total = blocks.reduce((sum, block) => sum + block.durationHours, 0);
  if (row.durationHours !== null && row.durationHours !== total) {
    issues.add(rowPath(row.rowNumber, 'duration'), 'DURATION_MISMATCH');
  }
}

/** Returns the identifier of the parent of a row, reporting a WBS number whose parent is not in the table. */
function parentIdOf(
  numbered: NumberedRow,
  idByWbs: ReadonlyMap<WbsNumber, string>,
  issues: IssueList,
): string | null {
  const parent = parentWbsNumber(numbered.wbs);
  if (parent === null) {
    return null;
  }
  const parentId = idByWbs.get(parent);
  if (parentId === undefined) {
    issues.add(rowPath(numbered.row.rowNumber, 'wbs'), 'UNKNOWN_REFERENCE');
    return null;
  }
  return parentId;
}

/** Returns the identifier of the tag of a row, creating the tag with the next palette color the first time its name appears. */
function tagIdOf(
  row: ParsedRow,
  tags: PlannedItem<Tag>[],
  tagIdByName: Map<string, string>,
): string | null {
  const name = row.tagName;
  if (name === null) {
    return null;
  }
  const known = tagIdByName.get(name);
  if (known !== undefined) {
    return known;
  }
  const id = `${TAG_ID_PREFIX}${String(tags.length + 1)}`;
  const color = nextPaletteColor(tags.length);
  tagIdByName.set(name, id);
  tags.push({
    item: { id, name, color, representsPersonOrTeam: false },
    rowNumber: row.rowNumber,
    column: 'tag',
  });
  return id;
}

/** Builds the task of a row, the fields a table cannot hold keeping their defaults. */
function taskOf(numbered: NumberedRow, kind: PlannedKind, links: TaskLinks): Task {
  const { row, id } = numbered;
  const base = { id, name: row.name, parentId: links.parentId, sortKey: links.sortKey };
  if (kind === 'summary') {
    return { ...base, kind };
  }
  const dated = {
    ...base,
    progressPercent: row.progressPercent ?? 0,
    tagId: links.tagId,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
  };
  if (kind === 'milestone') {
    return { ...dated, kind };
  }
  const segments = row.blocks ?? [
    { durationHours: row.durationHours ?? 0, gapDaysBefore: 0, startNoEarlierThan: null },
  ];
  return { ...dated, kind, segments, hoursPerDay: null, dailyStartHour: null };
}

/** Builds the dependencies of every row from its predecessors and its block waits, ignoring those of summaries, and reports WBS numbers that name no row. */
function planDependencies(
  { numbered, idByWbs }: Hierarchy,
  summaryIds: ReadonlySet<string>,
  issues: IssueList,
): PlannedItem<Dependency>[] {
  const dependencies: PlannedItem<Dependency>[] = [];
  const add = (row: ParsedRow, column: CsvColumn, link: Omit<Dependency, 'id'>): void => {
    const id = `${DEPENDENCY_ID_PREFIX}${String(dependencies.length + 1)}`;
    dependencies.push({ item: { id, ...link }, rowNumber: row.rowNumber, column });
  };
  const wanted = numbered.flatMap((numberedRow) =>
    wantedLinksOf(numberedRow, summaryIds.has(numberedRow.id)),
  );
  for (const { row, id, reference, column, block } of wanted) {
    const link = resolveReference(reference, idByWbs, rowPath(row.rowNumber, column), issues);
    if (link !== null) {
      add(row, column, { ...link, successorId: id, successorBlock: block });
    }
  }
  return dependencies;
}

/** Writes a planned link in its shortest form, a block its task would stand for anyway becoming the whole task. */
function shortened(
  planned: PlannedItem<Dependency>,
  taskById: ReadonlyMap<string, Task>,
): PlannedItem<Dependency> {
  const predecessor = taskById.get(planned.item.predecessorId);
  const successor = taskById.get(planned.item.successorId);
  if (predecessor === undefined || successor === undefined) {
    return planned;
  }
  return { ...planned, item: shortestLink(planned.item, predecessor, successor) };
}

/** Lists the links a row asks for: its predecessors, then what its blocks wait for unless it is a summary. */
function wantedLinksOf({ row, id }: NumberedRow, isSummary: boolean) {
  const waits = isSummary ? [] : row.blockWaits;
  return [
    ...row.predecessors.map((reference) => ({
      row,
      id,
      reference,
      column: PREDECESSORS,
      block: null,
    })),
    ...waits.map(({ reference, block }) => ({ row, id, reference, column: BLOCKS, block })),
  ];
}

/** Finds the task a predecessor names, reporting a WBS number that names no row. */
function resolveReference(
  { wbs, block, type, lagHours }: PredecessorReference,
  idByWbs: ReadonlyMap<WbsNumber, string>,
  path: string,
  issues: IssueList,
): Pick<Dependency, 'predecessorId' | 'predecessorBlock' | 'type' | 'lagHours'> | null {
  const predecessorId = idByWbs.get(wbs);
  if (predecessorId === undefined) {
    issues.add(path, 'UNKNOWN_REFERENCE');
    return null;
  }
  return { predecessorId, predecessorBlock: block, type, lagHours };
}
