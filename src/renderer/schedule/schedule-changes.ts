import { compareStrings } from '../../core/compare-strings';
import { success, type Result } from '../../core/result';
import type { ConflictDescription, ConflictLine, DateConflictLine } from '../plan/conflict-lines';
import type {
  Dependency,
  DependencyId,
  Project,
  Tag,
  TagId,
  Task,
  TaskId,
} from '../../core/model/project';
import type { TaskFloat } from '../../core/scheduling/backward-pass';
import type { SchedulingConflict } from '../../core/scheduling/forward-pass';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { SummarySchedule } from '../../core/scheduling/summaries';
import type { Placement } from '../../core/scheduling/task-placement';
import { projectChanges, type ListChanges } from '../../core/shared/project-changes';
import { valueAt } from '../../core/table-value';
import type { TagConflictReport } from '../../core/tags/tag-conflicts';

export interface ListDelta<Item, Id> {
  readonly put: readonly Item[];
  readonly removed: readonly Id[];
}

export interface ProjectDelta {
  readonly header: Project | null;
  readonly tasks: ListDelta<Task, TaskId>;
  readonly dependencies: ListDelta<Dependency, DependencyId>;
  readonly tags: ListDelta<Tag, TagId>;
}

export interface MapDelta<Value> {
  readonly put: readonly (readonly [TaskId, Value])[];
  readonly removed: readonly TaskId[];
}

export type FloatsDelta =
  | { readonly kind: 'same' }
  | { readonly kind: 'whole'; readonly floats: ReadonlyMap<TaskId, TaskFloat> | null }
  | { readonly kind: 'changes'; readonly changes: MapDelta<TaskFloat> };

export interface ScheduleDelta {
  readonly placements: MapDelta<Placement>;
  readonly summaries: MapDelta<SummarySchedule>;
  readonly wbsNumbers: MapDelta<string>;
  readonly floats: FloatsDelta;
  readonly conflicts: readonly SchedulingConflict[] | null;
  readonly tagConflicts: TagConflictReport | null;
}

export interface ScheduleTable {
  readonly placements: Map<TaskId, Placement>;
  readonly summaries: Map<TaskId, SummarySchedule>;
  readonly wbsNumbers: Map<TaskId, string>;
  floats: Map<TaskId, TaskFloat> | null;
  conflicts: readonly SchedulingConflict[];
  tagConflicts: TagConflictReport;
}

/** Writes what changed from one project to the next as a message for the schedule worker: the project with empty lists when a field of its header changed, and for each list the items added or replaced and the identifiers removed. */
export function projectDeltaOf(previous: Project, next: Project): ProjectDelta {
  const changes = projectChanges(previous, next);
  return {
    header: changes.header ? { ...next, tasks: [], dependencies: [], tags: [] } : null,
    tasks: listDeltaOf(changes.tasks),
    dependencies: listDeltaOf(changes.dependencies),
    tags: listDeltaOf(changes.tags),
  };
}

/** Writes the changes of one list as the items to put and the identifiers to remove. */
function listDeltaOf<Item extends { readonly id: Id }, Id>({
  added,
  replaced,
  removed,
}: ListChanges<Item>): ListDelta<Item, Id> {
  return {
    put: [...added, ...replaced.map(({ next }) => next)],
    removed: removed.map((item) => item.id),
  };
}

/** Gives the project a delta turns a project into, each list staying sorted by identifier. */
export function projectAfterDelta(project: Project, delta: ProjectDelta): Project {
  return {
    ...project,
    ...delta.header,
    tasks: listAfterDelta(project.tasks, delta.tasks),
    dependencies: listAfterDelta(project.dependencies, delta.dependencies),
    tags: listAfterDelta(project.tags, delta.tags),
  };
}

/** Merges into a list sorted by identifier the items to put, sorted first, leaving out the identifiers removed, in one walk. */
function listAfterDelta<Item extends { readonly id: Id }, Id extends string>(
  previous: readonly Item[],
  { put, removed }: ListDelta<Item, Id>,
): readonly Item[] {
  if (put.length === 0 && removed.length === 0) {
    return previous;
  }
  const gone = new Set<string>(removed);
  const arriving = [...put].sort((left, right) => compareStrings(left.id, right.id));
  const list: Item[] = [];
  let next = 0;
  for (const item of previous) {
    for (
      ;
      next < arriving.length && compareStrings(valueAt(arriving, next).id, item.id) < 0;
      next += 1
    ) {
      list.push(valueAt(arriving, next));
    }
    if (next < arriving.length && valueAt(arriving, next).id === item.id) {
      list.push(valueAt(arriving, next));
      next += 1;
    } else if (!gone.has(item.id)) {
      list.push(item);
    }
  }
  return list.concat(arriving.slice(next));
}

/** Writes what changed from one schedule to the next, comparing values rather than objects since each computation makes new ones. */
export function scheduleDeltaOf(previous: Schedule, next: Schedule): ScheduleDelta {
  return {
    placements: mapDeltaOf(previous.placements, next.placements),
    summaries: mapDeltaOf(previous.summaries, next.summaries),
    wbsNumbers: mapDeltaOf(previous.wbsNumbers, next.wbsNumbers),
    floats: floatsDeltaOf(previous.floats, next.floats),
    conflicts: sameData(previous.conflicts, next.conflicts) ? null : next.conflicts,
    tagConflicts: sameData(previous.tagConflicts, next.tagConflicts) ? null : next.tagConflicts,
  };
}

/** Writes what changed in the floats, which are either both absent, newly present or absent, or both present and compared entry by entry. */
function floatsDeltaOf(
  previous: ReadonlyMap<TaskId, TaskFloat> | null,
  next: ReadonlyMap<TaskId, TaskFloat> | null,
): FloatsDelta {
  if (previous === null && next === null) {
    return { kind: 'same' };
  }
  if (previous === null || next === null) {
    return { kind: 'whole', floats: next };
  }
  return { kind: 'changes', changes: mapDeltaOf(previous, next) };
}

/** Lists the entries of the second table that are new or hold another value, and the keys it no longer has. */
function mapDeltaOf<Value>(
  previous: ReadonlyMap<TaskId, Value>,
  next: ReadonlyMap<TaskId, Value>,
): MapDelta<Value> {
  const put: (readonly [TaskId, Value])[] = [];
  for (const [id, value] of next) {
    if (!previous.has(id) || !sameData(previous.get(id), value)) {
      put.push([id, value]);
    }
  }
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  return { put, removed };
}

/** Tells whether two plain values hold the same data: equal primitives, or arrays and objects whose entries hold the same data. */
export function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameData(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

/** Makes the table of a whole schedule, whose tables become the ones a page keeps and changes in place. */
export function scheduleTableOf(schedule: Schedule): ScheduleTable {
  return {
    placements: new Map(schedule.placements),
    summaries: new Map(schedule.summaries),
    wbsNumbers: new Map(schedule.wbsNumbers),
    floats: schedule.floats === null ? null : new Map(schedule.floats),
    conflicts: schedule.conflicts,
    tagConflicts: schedule.tagConflicts,
  };
}

/** Changes a schedule table in place by a delta. */
export function applyScheduleDelta(table: ScheduleTable, delta: ScheduleDelta): void {
  applyMapDelta(table.placements, delta.placements);
  applyMapDelta(table.summaries, delta.summaries);
  applyMapDelta(table.wbsNumbers, delta.wbsNumbers);
  table.floats = floatsAfter(table.floats, delta.floats);
  table.conflicts = delta.conflicts ?? table.conflicts;
  table.tagConflicts = delta.tagConflicts ?? table.tagConflicts;
}

/** Gives the floats a delta leaves, changing the table of floats in place when both sides have one. */
function floatsAfter(
  floats: Map<TaskId, TaskFloat> | null,
  delta: FloatsDelta,
): Map<TaskId, TaskFloat> | null {
  if (delta.kind === 'same') {
    return floats;
  }
  if (delta.kind === 'whole') {
    return delta.floats === null ? null : new Map(delta.floats);
  }
  if (floats === null) {
    throw new Error('Changes to the floats arrived for a schedule without floats.');
  }
  applyMapDelta(floats, delta.changes);
  return floats;
}

/** Puts and removes the entries of a delta in a table. */
function applyMapDelta<Value>(table: Map<TaskId, Value>, { put, removed }: MapDelta<Value>): void {
  for (const id of removed) {
    table.delete(id);
  }
  for (const [id, value] of put) {
    table.set(id, value);
  }
}

/** Shows a schedule table as a schedule, whose tables are the ones of the table and so change with it. */
export function scheduleOfTable(table: ScheduleTable): Schedule {
  return {
    placements: table.placements,
    summaries: table.summaries,
    wbsNumbers: table.wbsNumbers,
    floats: table.floats,
    conflicts: table.conflicts,
    tagConflicts: table.tagConflicts,
  };
}

export type LinesDelta<Line> =
  | { readonly kind: 'whole'; readonly lines: Result<readonly Line[], unknown> }
  | {
      readonly kind: 'changes';
      readonly length: number;
      readonly put: readonly (readonly [number, Line])[];
    };

export interface DescriptionDelta {
  readonly people: LinesDelta<ConflictLine>;
  readonly dates: LinesDelta<DateConflictLine>;
}

/** Writes what changed in the description of the conflicts: each part whole when it or the one before could not be described or the page holds none, else only its lines that changed, by position, with its new length. */
export function descriptionDeltaOf(
  previous: ConflictDescription | null,
  next: ConflictDescription,
): DescriptionDelta {
  return {
    people: linesDeltaOf(previous?.people ?? null, next.people),
    dates: linesDeltaOf(previous?.dates ?? null, next.dates),
  };
}

/** Writes what changed in one part of a description. */
function linesDeltaOf<Line>(
  previous: Result<readonly Line[], unknown> | null,
  next: Result<readonly Line[], unknown>,
): LinesDelta<Line> {
  if (previous === null || !previous.ok || !next.ok) {
    return { kind: 'whole', lines: next };
  }
  const put: (readonly [number, Line])[] = [];
  next.value.forEach((line, index) => {
    if (index >= previous.value.length || !sameData(previous.value[index], line)) {
      put.push([index, line]);
    }
  });
  return { kind: 'changes', length: next.value.length, put };
}

/** Gives the description of the conflicts a delta leaves, throwing on changes to a part the page does not hold. */
export function descriptionAfter(
  current: ConflictDescription | null,
  delta: DescriptionDelta,
): ConflictDescription {
  return {
    people: linesAfter(current?.people ?? null, delta.people),
    dates: linesAfter(current?.dates ?? null, delta.dates),
  };
}

/** Gives one part of a description after its delta, copying the lines kept and replacing the ones changed. */
function linesAfter<Line>(
  current: Result<readonly Line[], unknown> | null,
  delta: LinesDelta<Line>,
): Result<readonly Line[], unknown> {
  if (delta.kind === 'whole') {
    return delta.lines;
  }
  if (!current?.ok) {
    throw new Error('The schedule worker sent changes to conflicts the page does not hold.');
  }
  const lines = current.value.slice(0, delta.length);
  for (const [index, line] of delta.put) {
    lines[index] = line;
  }
  return success(lines);
}
