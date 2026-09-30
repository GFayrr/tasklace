import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { countWorkingHours } from '../../core/calendar/working-time';
import { parseCsvDate, type RegionalFormat } from '../../core/exchange/csv/regional-format';
import { parsePredecessors } from '../../core/exchange/csv/task-notations';
import { MAX_DEPENDENCIES } from '../../core/limits';
import type {
  Dependency,
  Milestone,
  Project,
  SummaryTask,
  TagId,
  Task,
  TaskId,
  WorkTask,
} from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { keyBetween, spreadKeys } from '../../core/shared/fractional-index';
import type { SharedOperation } from '../../core/shared/shared-operations';
import { dayIndexOf, QUARTER_HOUR, startOfDay, type ProjectHour } from '../../core/time';
import { parseDuration } from './durations';
import type { PlanOutline } from './plan-outline';

export type EditError =
  | 'NOT_POSSIBLE'
  | 'INVALID_NAME'
  | 'INVALID_DURATION'
  | 'INVALID_DATE'
  | 'INVALID_END'
  | 'INVALID_PROGRESS'
  | 'INVALID_PREDECESSORS'
  | 'UNKNOWN_TASK_NUMBER';

export type Edit = Result<readonly SharedOperation[], EditError>;

export interface EditContext {
  readonly project: Project;
  readonly outline: PlanOutline;
  readonly createId: () => string;
  readonly dayHours: number;
}

export interface InsertedTask {
  readonly taskId: TaskId;
  readonly operations: readonly SharedOperation[];
}

const PROGRESS_PATTERN = /^(\d{1,3})\s*%?$/;
const MAX_FIELD_LENGTH = 64;
const MAX_PROGRESS = 100;
const DECIMAL_RADIX = 10;

/** Adds a work task of one working day after a task, as its next sibling, or at the end of the plan. */
export function insertTask(
  context: EditContext,
  afterId: TaskId | null,
  name: string,
): Result<InsertedTask, EditError> {
  const after = afterId === null ? undefined : findTask(context, afterId);
  const parentId = after?.parentId ?? null;
  const siblings = siblingsOf(context, parentId);
  const position = after === undefined ? siblings.length : siblings.indexOf(after) + 1;
  const taskId = context.createId();
  const task: WorkTask = {
    kind: 'task',
    id: taskId,
    name,
    parentId,
    sortKey: '',
    segments: [{ durationHours: context.dayHours, gapDaysBefore: 0 }],
    hoursPerDay: null,
    dailyStartHour: null,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
  };
  return success({ taskId, operations: placeAmong(siblings, task, position) });
}

/** Deletes tasks together with everything under them. */
export function deleteTasks(context: EditContext, ids: readonly TaskId[]): Edit {
  const removed = new Set<TaskId>();
  const pending = [...ids];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!removed.has(id) && findTask(context, id) !== undefined) {
      removed.add(id);
      pending.push(...(context.outline.childrenById.get(id) ?? []).map((child) => child.id));
    }
  }
  return removed.size === 0
    ? failure('NOT_POSSIBLE')
    : success([{ type: 'removeTasks', ids: [...removed] }]);
}

/** Puts a task under the task above it among its siblings, which becomes a summary and loses its links if it was not one. */
export function indentTask(context: EditContext, id: TaskId): Edit {
  const task = findTask(context, id);
  if (task === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const siblings = siblingsOf(context, task.parentId);
  const parent = siblings[siblings.indexOf(task) - 1];
  if (parent === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const operations: SharedOperation[] = [];
  if (parent.kind !== 'summary') {
    operations.push(
      ...linksOf(context.project, parent.id).map(removeLink),
      putTask(asSummary(parent)),
    );
  }
  const children = siblingsOf(context, parent.id);
  operations.push(...placeAmong(children, { ...task, parentId: parent.id }, children.length));
  return success(operations);
}

/** Moves a task out of its summary, right after it. */
export function outdentTask(context: EditContext, id: TaskId): Edit {
  const task = findTask(context, id);
  const parent = task?.parentId == null ? undefined : findTask(context, task.parentId);
  if (task === undefined || parent === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const siblings = siblingsOf(context, parent.parentId);
  const moved = { ...task, parentId: parent.parentId };
  return success(placeAmong(siblings, moved, siblings.indexOf(parent) + 1));
}

/** Moves a task one place up or down among its siblings. */
export function moveTask(context: EditContext, id: TaskId, direction: -1 | 1): Edit {
  const task = findTask(context, id);
  if (task === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const siblings = siblingsOf(context, task.parentId);
  const index = siblings.indexOf(task);
  const position = index + direction;
  if (position < 0 || position >= siblings.length) {
    return failure('NOT_POSSIBLE');
  }
  const others = siblings.filter((sibling) => sibling.id !== id);
  return success(placeAmong(others, task, position));
}

/** Renames a task, refusing an empty name. */
export function renameTask(context: EditContext, id: TaskId, text: string): Edit {
  const task = findTask(context, id);
  const name = text.trim();
  if (task === undefined) {
    return failure('NOT_POSSIBLE');
  }
  return name === '' ? failure('INVALID_NAME') : success([putTask({ ...task, name })]);
}

/** Sets the duration written in hours, minutes or working days, rounded to the quarter hour, a work task becoming a milestone at zero and a milestone a work task above zero; for a split task, the last block takes the difference. */
export function setDuration(context: EditContext, id: TaskId, text: string): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  const hours = parseDuration(text, dayHoursOf(context, task));
  if (hours === null) {
    return failure('INVALID_DURATION');
  }
  if (hours === 0) {
    return success([putTask(asMilestone(task))]);
  }
  if (task.kind === 'milestone') {
    return success([putTask(asWorkTask(task, hours))]);
  }
  const earlier = task.segments.slice(0, -1);
  const last = hours - earlier.reduce((sum, segment) => sum + segment.durationHours, 0);
  const lastSegment = task.segments.at(-1);
  if (last < QUARTER_HOUR || lastSegment === undefined) {
    return failure('INVALID_DURATION');
  }
  return success([
    putTask({ ...task, segments: [...earlier, { ...lastSegment, durationHours: last }] }),
  ]);
}

/** Sets the date a task may not start before, written in the regional format or as an ISO date, an empty text removing it. */
export function setStart(
  context: EditContext,
  id: TaskId,
  text: string,
  format: RegionalFormat,
): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  if (text.trim() === '') {
    return success([putTask({ ...task, startNoEarlierThan: null })]);
  }
  const date = parseCsvDate(text, format);
  if (!date.ok) {
    return failure('INVALID_DATE');
  }
  const hour = date.value.kind === 'dateTime' ? date.value.hour : startOfDay(date.value.day);
  return success(startingAt(context, hour, [putTask({ ...task, startNoEarlierThan: hour })]));
}

/** Sets the end of a work task, changing the duration of its last block, or moves a milestone to that instant; a date without time ends the task at the end of that day. */
export function setEnd(
  context: EditContext,
  id: TaskId,
  text: string,
  format: RegionalFormat,
  placed: { readonly lastBlockStart: ProjectHour; readonly calendar: CompiledCalendar },
): Edit {
  const task = findTask(context, id);
  const date = parseCsvDate(text, format);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  if (!date.ok) {
    return failure('INVALID_DATE');
  }
  const end = date.value.kind === 'dateTime' ? date.value.hour : startOfDay(date.value.day + 1);
  if (task.kind === 'milestone') {
    return moveStart(context, id, end);
  }
  if (end <= placed.lastBlockStart) {
    return failure('INVALID_END');
  }
  return stretchEnd(context, id, placed.lastBlockStart, end, placed.calendar);
}

/** Sets the progress of a work task or milestone, a whole percentage from 0 to 100. */
export function setProgress(context: EditContext, id: TaskId, text: string): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  const match = text.length > MAX_FIELD_LENGTH ? null : PROGRESS_PATTERN.exec(text.trim());
  const percent = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], DECIMAL_RADIX);
  if (!(percent >= 0 && percent <= MAX_PROGRESS)) {
    return failure('INVALID_PROGRESS');
  }
  return success([putTask({ ...task, progressPercent: percent })]);
}

/** Replaces the predecessors of a task by those written as in the task table ("1.2, 3SS+2h"), keeping the identifier of each link that stays. */
export function setPredecessors(context: EditContext, id: TaskId, text: string): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  const references = parsePredecessors(text, MAX_DEPENDENCIES);
  if (!references.ok) {
    return failure('INVALID_PREDECESSORS');
  }
  const idByWbs = new Map([...context.outline.wbsById].map(([taskId, wbs]) => [wbs, taskId]));
  const current = new Map(
    context.project.dependencies
      .filter((dependency) => dependency.successorId === id)
      .map((dependency) => [dependency.predecessorId, dependency]),
  );
  const wanted = new Map<TaskId, Dependency>();
  for (const reference of references.value) {
    const predecessorId = idByWbs.get(reference.wbs);
    if (predecessorId === undefined) {
      return failure('UNKNOWN_TASK_NUMBER');
    }
    if (wanted.has(predecessorId)) {
      return failure('INVALID_PREDECESSORS');
    }
    const dependencyId = current.get(predecessorId)?.id ?? context.createId();
    const { type, lagHours } = reference;
    wanted.set(predecessorId, { id: dependencyId, predecessorId, successorId: id, type, lagHours });
  }
  const removed = [...current.values()].filter(
    (dependency) => !wanted.has(dependency.predecessorId),
  );
  const changed = [...wanted.values()].filter(
    (dependency) => !sameLink(current.get(dependency.predecessorId), dependency),
  );
  return success([
    ...removed.map(removeLink),
    ...changed.map((dependency): SharedOperation => ({ type: 'putDependency', dependency })),
  ]);
}

/** Gives a work task or milestone a tag, or none. */
export function setTag(context: EditContext, id: TaskId, tagId: TagId | null): Edit {
  const task = findTask(context, id);
  const known = tagId === null || context.project.tags.some((tag) => tag.id === tagId);
  if (task === undefined || task.kind === 'summary' || !known) {
    return failure('NOT_POSSIBLE');
  }
  return success([putTask({ ...task, tagId })]);
}

/** Replaces a task by its version edited in the details panel, moving the project start when the task now starts before it. */
export function replaceTask(context: EditContext, task: Task): Edit {
  if (findTask(context, task.id) === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const start = task.kind === 'summary' ? null : task.startNoEarlierThan;
  const operations = [putTask(task)];
  return success(start === null ? operations : startingAt(context, start, operations));
}

/** Turns a work task into a milestone or a milestone into a work task of one working day. */
export function toggleMilestone(context: EditContext, id: TaskId): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  return success([
    putTask(task.kind === 'task' ? asMilestone(task) : asWorkTask(task, dayHoursOf(context, task))),
  ]);
}

/** Asks a task not to start before an instant, as when its bar is moved. */
export function moveStart(context: EditContext, id: TaskId, hour: ProjectHour): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  return success(startingAt(context, hour, [putTask({ ...task, startNoEarlierThan: hour })]));
}

/** Changes the last block of a task so that it ends at an instant, as when its bar is stretched, keeping at least a quarter hour. */
export function stretchEnd(
  context: EditContext,
  id: TaskId,
  lastBlockStart: ProjectHour,
  end: ProjectHour,
  calendar: CompiledCalendar,
): Edit {
  const task = findTask(context, id);
  const lastSegment = task?.kind === 'task' ? task.segments.at(-1) : undefined;
  if (task?.kind !== 'task' || lastSegment === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const hours = countWorkingHours(calendar, lastBlockStart, Math.max(end, lastBlockStart));
  const durationHours = Math.max(QUARTER_HOUR, hours.ok ? hours.value : QUARTER_HOUR);
  const segments = [...task.segments.slice(0, -1), { ...lastSegment, durationHours }];
  return success([putTask({ ...task, segments })]);
}

/** Links two tasks so that the second starts after the first ends. */
export function linkTasks(context: EditContext, predecessorId: TaskId, successorId: TaskId): Edit {
  if (predecessorId === successorId) {
    return failure('NOT_POSSIBLE');
  }
  const dependency: Dependency = {
    id: context.createId(),
    predecessorId,
    successorId,
    type: 'finishToStart',
    lagHours: 0,
  };
  return success([{ type: 'putDependency', dependency }]);
}

/** Adds, before the operations placing a task at an instant, the move of the project start to the day of that instant when the project starts later. */
function startingAt(
  context: EditContext,
  hour: ProjectHour,
  operations: readonly SharedOperation[],
): SharedOperation[] {
  const dayStart = startOfDay(dayIndexOf(hour));
  if (dayStart >= context.project.startDate) {
    return [...operations];
  }
  return [{ type: 'updateProject', fields: { startDate: dayStart } }, ...operations];
}

/** Places a task among sorted siblings at a position, giving it a sort key between its neighbours, or spreading the keys of all of them again when none fits. */
function placeAmong(siblings: readonly Task[], task: Task, position: number): SharedOperation[] {
  const others = siblings.filter((sibling) => sibling.id !== task.id);
  const before = others[position - 1]?.sortKey ?? null;
  const after = others[position]?.sortKey ?? null;
  const key = keyBetween(before, after);
  if (key.ok) {
    return [putTask({ ...task, sortKey: key.value })];
  }
  const ordered = [...others.slice(0, position), task, ...others.slice(position)];
  const keys = spreadKeys(ordered.length);
  return ordered.map((sibling, index) =>
    putTask({ ...sibling, sortKey: keys[index] ?? sibling.sortKey }),
  );
}

/** Returns the sorted children of a parent, or the top-level tasks. */
function siblingsOf(context: EditContext, parentId: TaskId | null): readonly Task[] {
  return context.outline.childrenById.get(parentId) ?? [];
}

/** Finds a task of the project. */
function findTask(context: EditContext, id: TaskId): Task | undefined {
  return context.project.tasks.find((task) => task.id === id);
}

/** Returns the hours of a working day of a task: its own, or those of the project. */
function dayHoursOf(context: EditContext, task: WorkTask | Milestone): number {
  return task.kind === 'task' && task.hoursPerDay !== null ? task.hoursPerDay : context.dayHours;
}

/** Lists the links from or to a task. */
function linksOf(project: Project, id: TaskId): Dependency[] {
  return project.dependencies.filter(
    (dependency) => dependency.predecessorId === id || dependency.successorId === id,
  );
}

/** Tells whether two links have the same type and lag. */
function sameLink(current: Dependency | undefined, wanted: Dependency): boolean {
  return current?.type === wanted.type && current.lagHours === wanted.lagHours;
}

/** Builds the operation removing a link. */
function removeLink(dependency: Dependency): SharedOperation {
  return { type: 'removeDependency', id: dependency.id };
}

/** Builds the operation writing a task. */
function putTask(task: Task): SharedOperation {
  return { type: 'putTask', task };
}

/** Keeps only what a summary has of a task. */
function asSummary(task: Task): SummaryTask {
  const { id, name, parentId, sortKey } = task;
  return { kind: 'summary', id, name, parentId, sortKey };
}

/** Turns a work task into a milestone with the same dates and constraints. */
function asMilestone(task: WorkTask | Milestone): Milestone {
  const { id, name, parentId, sortKey, progressPercent, tagId } = task;
  const { startNoEarlierThan, mustFinishOn, deadline } = task;
  return {
    kind: 'milestone',
    id,
    name,
    parentId,
    sortKey,
    progressPercent,
    tagId,
    startNoEarlierThan,
    mustFinishOn,
    deadline,
  };
}

/** Turns a milestone into a work task of one block. */
function asWorkTask(task: Milestone, hours: number): WorkTask {
  return {
    ...task,
    kind: 'task',
    segments: [{ durationHours: hours, gapDaysBefore: 0 }],
    hoursPerDay: null,
    dailyStartHour: null,
  };
}
