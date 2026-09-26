import type { CompiledCalendar } from '../calendar/compile-calendar';
import { countWorkingHours } from '../calendar/working-time';
import { compareStrings } from '../compare-strings';
import { MAX_TASKS } from '../limits';
import type { Tag, TagId, Task, TaskId } from '../model/project';
import type { Placement } from '../scheduling/task-placement';
import type { ProjectHour } from '../time';

export interface TagConflict {
  readonly tagId: TagId;
  readonly start: ProjectHour;
  readonly end: ProjectHour;
  readonly taskIds: readonly TaskId[];
}

export interface TagConflictReport {
  readonly conflicts: readonly TagConflict[];
  readonly tasksWithUnknownTag: readonly TaskId[];
}

const MIN_TASKS_IN_CONFLICT = 2;
const EVENT_KINDS = 2;
const END_EVENT = 0;
const START_EVENT = 1;
const TASK_INDEX_BASE = MAX_TASKS;

interface TagEvents {
  readonly taskIds: TaskId[];
  readonly keys: number[];
}

interface ConflictGroup {
  readonly start: ProjectHour;
  readonly taskIndices: Set<number>;
  pendingEnd: ProjectHour | null;
}

interface SweepStep {
  readonly active: ReadonlySet<number>;
  readonly started: readonly number[];
  readonly time: ProjectHour;
  readonly calendar: CompiledCalendar;
}

/** Finds the periods where a person or team tag works on several tasks at once, and tasks whose tag no longer exists. */
export function detectTagConflicts(
  tasks: readonly Task[],
  tags: readonly Tag[],
  placements: ReadonlyMap<TaskId, Placement>,
  calendar: CompiledCalendar,
): TagConflictReport {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const tasksWithUnknownTag: TaskId[] = [];
  const eventsByTag = new Map<TagId, TagEvents>();
  for (const task of tasks) {
    const tagId = task.kind === 'summary' ? null : task.tagId;
    const tag = tagId === null ? undefined : tagsById.get(tagId);
    if (tagId !== null && tag === undefined) {
      tasksWithUnknownTag.push(task.id);
    } else if (tag?.representsPersonOrTeam === true) {
      appendSlotEvents(eventsByTag, tag.id, task.id, placements.get(task.id));
    }
  }
  const conflicts = [...eventsByTag].flatMap(([tagId, events]) =>
    sweepConflicts(tagId, events, calendar),
  );
  return {
    conflicts: conflicts.sort(compareConflicts),
    tasksWithUnknownTag: tasksWithUnknownTag.sort(compareStrings),
  };
}

/** Adds an encoded start and end event for every time slot of a task to the events of its tag. */
function appendSlotEvents(
  eventsByTag: Map<TagId, TagEvents>,
  tagId: TagId,
  taskId: TaskId,
  placement: Placement | undefined,
): void {
  const events = eventsByTag.get(tagId) ?? { taskIds: [], keys: [] };
  const taskIndex = events.taskIds.push(taskId) - 1;
  for (const segment of placement?.segments ?? []) {
    for (const slot of segment.slots) {
      events.keys.push(
        encodeEvent(slot.start, START_EVENT, taskIndex),
        encodeEvent(slot.end, END_EVENT, taskIndex),
      );
    }
  }
  eventsByTag.set(tagId, events);
}

/** Packs an event into one number whose natural order is by time, then ends before starts. */
function encodeEvent(time: ProjectHour, kind: number, taskIndex: number): number {
  return (time * EVENT_KINDS + kind) * TASK_INDEX_BASE + taskIndex;
}

/** Returns the instant of an encoded event. */
function eventTime(key: number): ProjectHour {
  return Math.floor(key / TASK_INDEX_BASE / EVENT_KINDS);
}

/** Walks the events of one tag in time order and groups the periods where two tasks or more are active. */
function sweepConflicts(
  tagId: TagId,
  { taskIds, keys }: TagEvents,
  calendar: CompiledCalendar,
): TagConflict[] {
  const sortedKeys = Float64Array.from(keys).sort();
  const active = new Set<number>();
  const conflicts: TagConflict[] = [];
  const close = (group: ConflictGroup): void => {
    conflicts.push({ tagId, ...finishGroup(group, taskIds) });
  };
  let group: ConflictGroup | null = null;
  let index = 0;
  while (index < sortedKeys.length) {
    const time = eventTime(sortedKeys[index] ?? 0);
    const started: number[] = [];
    index = applyEventsAt(sortedKeys, index, active, started);
    group = advanceGroup(group, { active, started, time, calendar }, close);
  }
  if (group !== null) {
    close(group);
  }
  return conflicts;
}

/** Applies every event happening at the same instant, noting started tasks, and returns the next index. */
function applyEventsAt(
  sortedKeys: Float64Array,
  firstIndex: number,
  active: Set<number>,
  started: number[],
): number {
  const time = eventTime(sortedKeys[firstIndex] ?? 0);
  let index = firstIndex;
  for (
    let key = sortedKeys[index];
    key !== undefined && eventTime(key) === time;
    key = sortedKeys[index]
  ) {
    const taskIndex = key % TASK_INDEX_BASE;
    if (Math.floor(key / TASK_INDEX_BASE) % EVENT_KINDS === START_EVENT) {
      active.add(taskIndex);
      started.push(taskIndex);
    } else {
      active.delete(taskIndex);
    }
    index += 1;
  }
  return index;
}

/** Updates the current conflict group, keeping it open across gaps that contain no working hour. */
function advanceGroup(
  group: ConflictGroup | null,
  { active, started, time, calendar }: SweepStep,
  close: (group: ConflictGroup) => void,
): ConflictGroup | null {
  if (active.size < MIN_TASKS_IN_CONFLICT) {
    if (group !== null) {
      group.pendingEnd ??= time;
    }
    return group;
  }
  if (group !== null && canContinue(group, time, calendar)) {
    const joining = group.pendingEnd === null ? started : active;
    joining.forEach((taskIndex) => group.taskIndices.add(taskIndex));
    group.pendingEnd = null;
    return group;
  }
  if (group !== null) {
    close(group);
  }
  return { start: time, taskIndices: new Set(active), pendingEnd: null };
}

/** Tells whether a group is still open, or paused only by time without any working hour. */
function canContinue(group: ConflictGroup, time: ProjectHour, calendar: CompiledCalendar): boolean {
  if (group.pendingEnd === null) {
    return true;
  }
  const gap = countWorkingHours(calendar, group.pendingEnd, time);
  return gap.ok && gap.value === 0;
}

/** Turns a closed group into a conflict with its end and sorted task identifiers. */
function finishGroup(group: ConflictGroup, taskIds: readonly TaskId[]): Omit<TagConflict, 'tagId'> {
  return {
    start: group.start,
    end: group.pendingEnd ?? group.start,
    taskIds: [...group.taskIndices]
      .map((taskIndex) => taskIds[taskIndex] ?? '')
      .sort(compareStrings),
  };
}

/** Orders conflicts by tag, then by start time. */
function compareConflicts(left: TagConflict, right: TagConflict): number {
  return compareStrings(left.tagId, right.tagId) || left.start - right.start;
}
