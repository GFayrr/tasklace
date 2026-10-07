import { parseTableDate } from './table-dates';
import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { countWorkingHours } from '../../core/calendar/working-time';
import { parsePredecessors } from '../../core/exchange/csv/task-notations';
import { MAX_DEPENDENCIES } from '../../core/limits';
import type {
  Dependency,
  DependencyType,
  Milestone,
  Project,
  SummaryTask,
  TagId,
  Task,
  TaskId,
  WorkTask,
} from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import {
  blockKey,
  isKnownBlock,
  predecessorBlockOf,
  shortestLink,
  unitCountOf,
} from '../../core/scheduling/block-links';
import type { Placement } from '../../core/scheduling/task-placement';
import { keyBetween, spreadKeys } from '../../core/shared/fractional-index';
import type { SharedOperation } from '../../core/shared/shared-operations';
import type { EditError, EditRefusal } from './edit-refusal';
import { dayIndexOf, QUARTER_HOUR, startOfDay, type ProjectHour } from '../../core/time';
import { relinkBlocks } from './block-links';
import { parseDuration } from './durations';
import { predecessorText, taskIdOfNumber, type PlanOutline } from './plan-outline';

export type Edit = Result<readonly SharedOperation[], EditError>;

export type EditBuild = (context: EditContext) => Result<readonly SharedOperation[], EditRefusal>;

export interface EditContext {
  readonly project: Project;
  readonly outline: PlanOutline;
  readonly createId: () => string;
  readonly dayHours: number;
}

export interface LinkEnd {
  readonly taskId: TaskId;
  readonly block: number | null;
}

export interface BlockChoice {
  readonly origin: number | null;
  readonly waitsFor: string;
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
): InsertedTask {
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
    segments: [{ durationHours: context.dayHours, gapDaysBefore: 0, startNoEarlierThan: null }],
    hoursPerDay: null,
    dailyStartHour: null,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
  };
  return { taskId, operations: placeAmong(siblings, task, position) };
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
    return task.kind === 'task' ? toMilestone(context, task) : success([]);
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

/** Sets the date a task may not start before, written as an ISO date, an empty text removing it, the start dates of its later blocks moving by as much as the task when its scheduled start is known. */
export function setStart(
  context: EditContext,
  id: TaskId,
  text: string,
  scheduledStart: ProjectHour | null = null,
): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  if (text.trim() === '') {
    return success([putTask({ ...task, startNoEarlierThan: null })]);
  }
  const date = parseTableDate(text);
  if (!date.ok) {
    return failure('INVALID_DATE');
  }
  const hour = date.value.kind === 'dateTime' ? date.value.hour : startOfDay(date.value.day);
  return moveStart(context, id, hour, scheduledStart);
}

/** Sets the end of a work task, written as an ISO date, changing the duration of its last block, or moves a milestone to that instant; a date without time ends the task at the end of that day. */
export function setEnd(
  context: EditContext,
  id: TaskId,
  text: string,
  placed: { readonly lastBlockStart: ProjectHour; readonly calendar: CompiledCalendar },
): Edit {
  const task = findTask(context, id);
  const date = parseTableDate(text);
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

/** Replaces the predecessors of a task, or of one of its blocks, by those written as in the task table ("1.2, 3#2SS+2h"), keeping the identifier of each link that stays. */
export function setPredecessors(
  context: EditContext,
  id: TaskId,
  text: string,
  block: number | null = null,
): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary' || !isKnownBlock(task, block)) {
    return failure('NOT_POSSIBLE');
  }
  return replaceIncoming(context, context.project.dependencies, { taskId: id, block }, text);
}

/** Lists the operations replacing the links that lead to a task or block by those written, among the given links of the project. */
function replaceIncoming(
  context: EditContext,
  links: readonly Dependency[],
  target: LinkEnd,
  text: string,
): Edit {
  const references = parsePredecessors(text, MAX_DEPENDENCIES);
  if (!references.ok) {
    return failure('INVALID_PREDECESSORS');
  }
  const current = new Map(
    links
      .filter((link) => link.successorId === target.taskId && link.successorBlock === target.block)
      .map((link) => [blockKey(link.predecessorId, link.predecessorBlock), link]),
  );
  const wanted = new Map<string, Dependency>();
  for (const reference of references.value) {
    const source = resolveSource(context, reference.wbs, reference.block, reference.type);
    if (!source.ok) {
      return source;
    }
    const key = blockKey(source.value.taskId, source.value.block);
    if (wanted.has(key)) {
      return failure('INVALID_PREDECESSORS');
    }
    wanted.set(key, {
      id: current.get(key)?.id ?? context.createId(),
      predecessorId: source.value.taskId,
      predecessorBlock: source.value.block,
      successorId: target.taskId,
      successorBlock: target.block,
      type: reference.type,
      lagHours: reference.lagHours,
    });
  }
  const removed = [...current].filter(([key]) => !wanted.has(key)).map(([, link]) => link);
  const changed = [...wanted].filter(([key, link]) => !sameLink(current.get(key), link));
  return success([
    ...removed.map(removeLink),
    ...changed.map(([, dependency]): SharedOperation => ({ type: 'putDependency', dependency })),
  ]);
}

/** Finds the task, and the block of it, that a task number and an optional block number name, a block that the whole task would stand for anyway for a link of that type becoming the whole task. */
function resolveSource(
  context: EditContext,
  wbs: string,
  block: number | null,
  type: DependencyType,
): Result<LinkEnd, EditError> {
  const taskId = taskIdOfNumber(context.outline, wbs);
  const task = taskId === undefined ? undefined : findTask(context, taskId);
  if (taskId === undefined || task === undefined) {
    return failure('UNKNOWN_TASK_NUMBER');
  }
  if (!isKnownBlock(task, block)) {
    return failure('UNKNOWN_BLOCK');
  }
  const leaves = { type, predecessorBlock: null, successorBlock: null };
  const whole = block === predecessorBlockOf(leaves, unitCountOf(task));
  return success({ taskId, block: whole ? null : block });
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

/** Replaces a task by its version edited in the details panel, moving the project start if needed and keeping the links of its blocks on the right blocks. */
export function replaceTask(
  context: EditContext,
  task: Task,
  blocks: readonly BlockChoice[] = [],
): Edit {
  if (findTask(context, task.id) === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const start = task.kind === 'summary' ? null : task.startNoEarlierThan;
  const written = [putTask(task)];
  const operations = start === null ? written : startingAt(context, start, written);
  if (task.kind !== 'task' || blocks.length === 0) {
    return success(operations);
  }
  if (!keepsBlockOrder(task, blocks)) {
    return failure('NOT_POSSIBLE');
  }
  const origins = blocks.map((block) => block.origin);
  const relinked = relinkBlocks(
    context.project,
    task.id,
    (oldIndex) => (origins.includes(oldIndex) ? origins.indexOf(oldIndex) : null),
    task.segments.length,
  );
  if (relinked.losesLink) {
    return failure('LINKS_WOULD_MERGE');
  }
  const waits = waitOperations(context, task, blocks, relinked.links);
  return waits.ok ? success([...relinked.operations, ...operations, ...waits.value]) : waits;
}

/** Tells whether the chosen blocks match the blocks of a work task one for one, keeping the order of the old ones and adding new ones at the end only. */
function keepsBlockOrder(task: WorkTask, blocks: readonly BlockChoice[]): boolean {
  const firstNew = blocks.findIndex((block) => block.origin === null);
  const kept = blocks.slice(0, firstNew < 0 ? blocks.length : firstNew);
  const increasing = kept.every(
    (block, index) => index === 0 || (block.origin ?? 0) > (kept[index - 1]?.origin ?? 0),
  );
  const onlyNewAfter = blocks.slice(kept.length).every((block) => block.origin === null);
  return blocks.length === task.segments.length && increasing && onlyNewAfter;
}

/** Lists the operations writing what each block of a split task waits for, a task left with one block accepting only what its block already waited for. */
function waitOperations(
  context: EditContext,
  task: WorkTask,
  blocks: readonly BlockChoice[],
  links: readonly Dependency[],
): Edit {
  if (task.segments.length < 2) {
    const unchanged = blocks.every(
      (block) => block.waitsFor.trim() === writtenWaits(context, task.id, block.origin),
    );
    return unchanged ? success([]) : failure('WAITS_NEED_TWO_BLOCKS');
  }
  const operations: SharedOperation[] = [];
  for (const [block, { waitsFor }] of blocks.entries()) {
    const edit = replaceIncoming(context, links, { taskId: task.id, block }, waitsFor);
    if (!edit.ok) {
      return edit;
    }
    operations.push(...edit.value);
  }
  return success(operations);
}

/** Writes what a block of a task waits for in the project as it is, nothing for a new block. */
function writtenWaits(context: EditContext, taskId: TaskId, origin: number | null): string {
  if (origin === null) {
    return '';
  }
  const incoming = context.project.dependencies.filter((link) => link.successorId === taskId);
  return predecessorText(incoming, context.outline.wbsById, origin);
}

/** Finds the first block whose waits cannot be read or name a task or block that does not exist, so that the details panel can tell which field to fix. */
export function findBlockWaitProblem(
  context: EditContext,
  blocks: readonly BlockChoice[],
): { readonly block: number; readonly error: EditError } | null {
  for (const [block, { waitsFor }] of blocks.entries()) {
    const references = parsePredecessors(waitsFor, MAX_DEPENDENCIES);
    if (!references.ok) {
      return { block, error: 'INVALID_PREDECESSORS' };
    }
    const [error] = references.value.flatMap((reference) => {
      const source = resolveSource(context, reference.wbs, reference.block, reference.type);
      return source.ok ? [] : [source.error];
    });
    if (error !== undefined) {
      return { block, error };
    }
  }
  return null;
}

/** Turns a work task into a milestone or a milestone into a work task of one working day. */
export function toggleMilestone(context: EditContext, id: TaskId): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  return task.kind === 'task'
    ? toMilestone(context, task)
    : success([putTask(asWorkTask(task, dayHoursOf(context, task)))]);
}

/** Asks a task not to start before an instant, as when its bar is moved, the start dates of its later blocks moving by as much as the task when its scheduled start is known. */
export function moveStart(
  context: EditContext,
  id: TaskId,
  hour: ProjectHour,
  scheduledStart: ProjectHour | null = null,
): Edit {
  const task = findTask(context, id);
  if (task === undefined || task.kind === 'summary') {
    return failure('NOT_POSSIBLE');
  }
  const shift = scheduledStart === null ? 0 : hour - scheduledStart;
  const moved = task.kind === 'task' ? withBlockStartsShifted(task, shift) : task;
  return success(startingAt(context, hour, [putTask({ ...moved, startNoEarlierThan: hour })]));
}

/** Moves the start dates of the later blocks of a work task by a number of hours. */
function withBlockStartsShifted(task: WorkTask, shift: number): WorkTask {
  if (shift === 0) {
    return task;
  }
  const segments = task.segments.map((segment) =>
    segment.startNoEarlierThan === null
      ? segment
      : { ...segment, startNoEarlierThan: segment.startNoEarlierThan + shift },
  );
  return { ...task, segments };
}

/** Moves what was dragged on the timeline: a later block alone when one was grabbed, otherwise the whole task, the drop turning the scheduled start into the asked one, refusing a block or task the schedule no longer shows. */
export function moveOnTimeline(
  context: EditContext,
  id: TaskId,
  block: number | null,
  placement: Placement | undefined,
  dropped: (scheduledStart: ProjectHour) => ProjectHour,
): Edit {
  if (placement === undefined) {
    return failure('NOT_POSSIBLE');
  }
  if (block === null) {
    return moveStart(context, id, dropped(placement.start), placement.start);
  }
  const moved = placement.segments[block];
  const previous = placement.segments[block - 1];
  if (moved === undefined || previous === undefined) {
    return failure('NOT_POSSIBLE');
  }
  return moveBlock(context, id, block, { start: dropped(moved.start), previousEnd: previous.end });
}

/** Asks a later block of a split task not to start before an instant, as when it is dragged alone, its gap in days becoming the number of days from the end of the previous block, a block dropped before that end staying right after it without a date of its own. */
export function moveBlock(
  context: EditContext,
  id: TaskId,
  block: number,
  { start: hour, previousEnd }: { readonly start: ProjectHour; readonly previousEnd: ProjectHour },
): Edit {
  const task = findTask(context, id);
  if (task?.kind !== 'task' || block < 1 || block >= task.segments.length) {
    return failure('NOT_POSSIBLE');
  }
  const afterPrevious = hour > previousEnd;
  const gapDaysBefore = afterPrevious
    ? dayIndexOf(hour) - dayIndexOf(previousEnd - QUARTER_HOUR)
    : 0;
  const startNoEarlierThan = afterPrevious ? hour : null;
  const segments = task.segments.map((segment, index) =>
    index === block ? { ...segment, gapDaysBefore, startNoEarlierThan } : segment,
  );
  return success([putTask({ ...task, segments })]);
}

/** Changes the last block of a task so that it ends where its stretched bar was dropped, refusing it when the task has no placement or the calendar is not available. */
export function stretchOnTimeline(
  context: EditContext,
  id: TaskId,
  placed: { readonly placement: Placement | undefined; readonly calendar: CompiledCalendar | null },
  dropped: (scheduledEnd: ProjectHour) => ProjectHour,
): Edit {
  const lastBlock = placed.placement?.segments.at(-1);
  if (placed.placement === undefined || lastBlock === undefined || placed.calendar === null) {
    return failure('NOT_POSSIBLE');
  }
  return stretchEnd(context, id, lastBlock.start, dropped(placed.placement.end), placed.calendar);
}

/** Changes the last block of a task so that it ends at an instant, as when its bar is stretched, keeping at least a quarter hour and refusing an end beyond the dates the calendar covers. */
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
  if (!hours.ok) {
    return failure('OUT_OF_RANGE');
  }
  const durationHours = Math.max(QUARTER_HOUR, hours.value);
  const segments = [...task.segments.slice(0, -1), { ...lastSegment, durationHours }];
  return success([putTask({ ...task, segments })]);
}

/** Links two tasks, or blocks of them, so that the second starts after the first ends, a block of a task that is not split meaning the whole task. */
export function linkTasks(context: EditContext, from: LinkEnd, to: LinkEnd): Edit {
  const predecessor = findTask(context, from.taskId);
  const successor = findTask(context, to.taskId);
  if (predecessor === undefined || successor === undefined || from.taskId === to.taskId) {
    return failure('NOT_POSSIBLE');
  }
  const predecessorBlock = blockOf(predecessor, from.block);
  const successorBlock = blockOf(successor, to.block);
  if (!predecessorBlock.ok || !successorBlock.ok) {
    return failure('UNKNOWN_BLOCK');
  }
  const dependency: Dependency = {
    id: context.createId(),
    predecessorId: from.taskId,
    predecessorBlock: predecessorBlock.value,
    successorId: to.taskId,
    successorBlock: successorBlock.value,
    type: 'finishToStart',
    lagHours: 0,
  };
  return success([
    { type: 'putDependency', dependency: shortestLink(dependency, predecessor, successor) },
  ]);
}

/** Returns the block of a task a gesture names: the whole task when the task is not split, or the block when the task has it. */
function blockOf(task: Task, block: number | null): Result<number | null, EditError> {
  const split = task.kind === 'task' && task.segments.length > 1;
  if (block === null || !split) {
    return success(null);
  }
  return isKnownBlock(task, block) ? success(block) : failure('UNKNOWN_BLOCK');
}

/** Turns a work task into a milestone, its links to or from its blocks first pointing at the whole task, unless two different links would then become one. */
function toMilestone(context: EditContext, task: WorkTask): Edit {
  const relinked = relinkBlocks(context.project, task.id, (oldIndex) => oldIndex, 1);
  if (relinked.losesLink) {
    return failure('LINKS_WOULD_MERGE');
  }
  return success([...relinked.operations, putTask(asMilestone(task))]);
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
function asMilestone(task: WorkTask): Milestone {
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
    segments: [{ durationHours: hours, gapDaysBefore: 0, startNoEarlierThan: null }],
    hoursPerDay: null,
    dailyStartHour: null,
  };
}
