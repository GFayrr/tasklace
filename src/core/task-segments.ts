import type { TaskSegment, TaskSegments } from './model/project';

/** Gives a list of blocks as the blocks of a work task, which always has one at least, or null for an empty list. */
export function nonEmptySegments(segments: readonly TaskSegment[]): TaskSegments | null {
  const [first, ...rest] = segments;
  return first === undefined ? null : [first, ...rest];
}

/** Changes every block of a task, keeping as many blocks, one at least. */
export function mapSegments(
  segments: TaskSegments,
  change: (segment: TaskSegment, index: number) => TaskSegment,
): TaskSegments {
  const [first, ...rest] = segments;
  return [change(first, 0), ...rest.map((segment, index) => change(segment, index + 1))];
}

/** Changes the last block of a task, keeping the others as they are. */
export function withLastSegment(
  segments: TaskSegments,
  change: (last: TaskSegment) => TaskSegment,
): TaskSegments {
  return mapSegments(segments, (segment, index) =>
    index === segments.length - 1 ? change(segment) : segment,
  );
}
