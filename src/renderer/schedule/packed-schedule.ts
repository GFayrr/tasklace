import { isTaskId } from '../../core/identifiers';
import { MAX_SEGMENTS_PER_TASK } from '../../core/limits';
import type { TaskId } from '../../core/model/project';
import type { TaskFloat } from '../../core/scheduling/backward-pass';
import type { Placement, ScheduledSegment } from '../../core/scheduling/task-placement';
import type { TagConflict } from '../../core/tags/tag-conflicts';
import {
  END_PROJECT_HOUR,
  isQuarterHours,
  MIN_PROJECT_HOUR,
  type ProjectHour,
} from '../../core/time';

export interface PackedEntries {
  readonly ids: readonly TaskId[];
  readonly numbers: Float64Array;
  readonly removed: readonly TaskId[];
}

const NUMBERS_BEFORE_SEGMENTS = 3;
const NUMBERS_PER_SEGMENT = 2;
const NUMBERS_PER_KNOWN_FLOAT = 6;
const UNKNOWN_FLOAT_MARK = 0;
const KNOWN_FLOAT_MARK = 1;
const NOT_CRITICAL = 0;
const CRITICAL = 1;
const NUMBERS_PER_TIMES = 2;
const UNKNOWN_FLOAT: TaskFloat = {
  lateStart: null,
  lateFinish: null,
  totalFloatHours: null,
  freeFloatHours: null,
  isCritical: true,
};

/** Writes placements as their task identifiers and one list of numbers, start, end, block count then the start and end of each block, which a worker hands over without copying it. */
export function packPlacements(
  put: readonly (readonly [TaskId, Placement])[],
  removed: readonly TaskId[],
): PackedEntries {
  let size = 0;
  for (const [, placement] of put) {
    size += NUMBERS_BEFORE_SEGMENTS + NUMBERS_PER_SEGMENT * placement.segments.length;
  }
  const numbers = new Float64Array(size);
  let at = 0;
  /** Writes the next number. */
  const write = (value: number): void => {
    numbers[at] = value;
    at += 1;
  };
  for (const [, placement] of put) {
    write(placement.start);
    write(placement.end);
    write(placement.segments.length);
    for (const segment of placement.segments) {
      write(segment.start);
      write(segment.end);
    }
  }
  return { ids: put.map(([id]) => id), numbers, removed };
}

/** Reads packed placements into a table, throwing on any identifier, hour, block count or length a worker of this application cannot have written, after which the page drops the table. */
export function unpackPlacements(packed: PackedEntries, table: Map<TaskId, Placement>): void {
  const { ids, numbers } = packed;
  removeAll(table, packed.removed);
  let at = 0;
  for (const id of ids) {
    const count = countAt(numbers, at + 2, MAX_SEGMENTS_PER_TASK);
    const segments: ScheduledSegment[] = [];
    for (let index = 0; index < count; index += 1) {
      const segmentAt = at + NUMBERS_BEFORE_SEGMENTS + index * NUMBERS_PER_SEGMENT;
      segments.push({ start: hourAt(numbers, segmentAt), end: hourAt(numbers, segmentAt + 1) });
    }
    table.set(readId(id), { start: hourAt(numbers, at), end: hourAt(numbers, at + 1), segments });
    at += NUMBERS_BEFORE_SEGMENTS + count * NUMBERS_PER_SEGMENT;
  }
  requireLength(numbers, at);
}

/** Writes floats as their task identifiers and one list of numbers: a mark for an unknown float, or a mark then the late start, late finish, total float, free float and whether the task is critical. */
export function packFloats(
  put: readonly (readonly [TaskId, TaskFloat])[],
  removed: readonly TaskId[],
): PackedEntries {
  const numbers = new Float64Array(
    put.reduce(
      (size, [, float]) => size + (float.lateStart === null ? 1 : NUMBERS_PER_KNOWN_FLOAT),
      0,
    ),
  );
  let at = 0;
  for (const [, float] of put) {
    if (float.lateStart === null) {
      numbers[at] = UNKNOWN_FLOAT_MARK;
      at += 1;
    } else {
      numbers.set(
        [
          KNOWN_FLOAT_MARK,
          float.lateStart,
          float.lateFinish,
          float.totalFloatHours,
          float.freeFloatHours,
          float.isCritical ? CRITICAL : NOT_CRITICAL,
        ],
        at,
      );
      at += NUMBERS_PER_KNOWN_FLOAT;
    }
  }
  return { ids: put.map(([id]) => id), numbers, removed };
}

/** Reads packed floats into a table, throwing on anything a worker of this application cannot have written, after which the page drops the table. */
export function unpackFloats(packed: PackedEntries, table: Map<TaskId, TaskFloat>): void {
  const { ids, numbers } = packed;
  removeAll(table, packed.removed);
  let at = 0;
  for (const id of ids) {
    const known = countAt(numbers, at, KNOWN_FLOAT_MARK) === KNOWN_FLOAT_MARK;
    table.set(readId(id), known ? knownFloatAt(numbers, at + 1) : UNKNOWN_FLOAT);
    at += known ? NUMBERS_PER_KNOWN_FLOAT : 1;
  }
  requireLength(numbers, at);
}

/** Reads the float whose late start is at a place of a packed list. */
function knownFloatAt(numbers: Float64Array, index: number): TaskFloat {
  return {
    lateStart: hourAt(numbers, index),
    lateFinish: hourAt(numbers, index + 1),
    totalFloatHours: hoursAt(numbers, index + 2),
    freeFloatHours: hoursAt(numbers, index + 3),
    isCritical: countAt(numbers, index + 4, CRITICAL) === CRITICAL,
  };
}

/** Tells whether two conflicts differ at most by their start and end. */
export function differOnlyByTimes(previous: TagConflict, next: TagConflict): boolean {
  return (
    previous.tagId === next.tagId &&
    previous.taskIds.length === next.taskIds.length &&
    previous.taskIds.every((id, index) => id === next.taskIds[index])
  );
}

/** Writes the start and end of each conflict, in order, as one list of numbers. */
export function packTimes(conflicts: readonly TagConflict[]): Float64Array {
  const times = new Float64Array(conflicts.length * NUMBERS_PER_TIMES);
  conflicts.forEach((conflict, index) => {
    times[index * NUMBERS_PER_TIMES] = conflict.start;
    times[index * NUMBERS_PER_TIMES + 1] = conflict.end;
  });
  return times;
}

/** Gives the conflicts with the starts and ends of a packed list, throwing when it does not hold exactly one start and end per conflict or holds an hour a worker cannot have written. */
export function withTimes(conflicts: readonly TagConflict[], times: Float64Array): TagConflict[] {
  if (times.length !== conflicts.length * NUMBERS_PER_TIMES) {
    throw new Error('The schedule worker sent the times of another number of conflicts.');
  }
  return conflicts.map((conflict, index) => ({
    ...conflict,
    start: hourAt(times, index * NUMBERS_PER_TIMES),
    end: hourAt(times, index * NUMBERS_PER_TIMES + 1),
  }));
}

/** Lists the buffers of the packed parts of a message, which a worker hands over to the page instead of copying them. */
export function packedBuffers(numbers: readonly (Float64Array | null)[]): ArrayBuffer[] {
  return numbers.flatMap((list) =>
    list !== null && list.buffer instanceof ArrayBuffer ? [list.buffer] : [],
  );
}

/** Gives the number at a place of a packed list, throwing when the list ends before it. */
function numberAt(numbers: Float64Array, index: number): number {
  const value = numbers[index];
  if (value === undefined) {
    throw new Error('The schedule worker sent a packed list that ends too soon.');
  }
  return value;
}

/** Gives the number of hours at a place of a packed list, throwing on a value that is not a whole number of quarter hours. */
function hoursAt(numbers: Float64Array, index: number): number {
  const value = numberAt(numbers, index);
  if (!isQuarterHours(value)) {
    throw new Error(`The schedule worker sent ${String(value)}, which is not a number of hours.`);
  }
  return value;
}

/** Gives the hour at a place of a packed list, throwing on a value that is not a quarter hour of the years handled. */
function hourAt(numbers: Float64Array, index: number): ProjectHour {
  const value = hoursAt(numbers, index);
  if (value < MIN_PROJECT_HOUR || value > END_PROJECT_HOUR) {
    throw new Error(
      `The schedule worker sent the hour ${String(value)}, outside the years handled.`,
    );
  }
  return value;
}

/** Gives the count at a place of a packed list, throwing on a value that is not a whole number from 0 to a maximum. */
function countAt(numbers: Float64Array, index: number, maximum: number): number {
  const value = numberAt(numbers, index);
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `The schedule worker sent the count ${String(value)}, outside 0 to ${String(maximum)}.`,
    );
  }
  return value;
}

/** Throws when a packed list holds more numbers than its entries read. */
function requireLength(numbers: Float64Array, read: number): void {
  if (read !== numbers.length) {
    throw new Error('The schedule worker sent a packed list longer than its entries.');
  }
}

/** Gives a value the schedule worker sent as a task identifier, throwing when it cannot be one. */
export function readId(value: unknown): TaskId {
  if (!isTaskId(value)) {
    throw new Error('The schedule worker sent a value that is not a task identifier.');
  }
  return value;
}

/** Removes the entries of identifiers from a table, throwing on a value that cannot be an identifier. */
export function removeAll<Value>(table: Map<TaskId, Value>, removed: readonly TaskId[]): void {
  for (const id of removed) {
    table.delete(readId(id));
  }
}
