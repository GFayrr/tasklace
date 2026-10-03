import type { TaskId } from '../../core/model/project';
import { HOURS_PER_DAY, type ProjectHour } from '../../core/time';
import {
  BAR_HEIGHT,
  MILESTONE_SIZE,
  rowMiddle,
  type Point,
  type RowShape,
  type TimelineFrame,
} from './timeline-geometry';

export type GestureKind = 'move' | 'stretch' | 'link';

export interface GestureTarget {
  readonly kind: GestureKind;
  readonly taskId: TaskId;
  readonly shape: RowShape;
  readonly block: number | null;
}

export interface LinkHandle {
  readonly block: number | null;
  readonly center: Point;
}

export type DragPreview =
  | {
      readonly kind: 'move';
      readonly shape: RowShape;
      readonly offset: number;
      readonly block: number | null;
    }
  | { readonly kind: 'stretch'; readonly shape: RowShape; readonly offset: number }
  | {
      readonly kind: 'link';
      readonly shape: RowShape;
      readonly block: number | null;
      readonly pointer: Point;
      readonly targetRow: number | null;
      readonly targetBlock: number | null;
    };

export const LINK_HANDLE_RADIUS = 5;
export const LINK_HANDLE_GAP = 12;
export const STRETCH_ZONE = 6;
export const DRAG_THRESHOLD = 3;

const HALF = 2;

/** Lists the handles from which a link is dragged: one at the end of each block of a split task but the last, and one after the bar standing for the end of the whole task. */
export function linkHandles(shape: RowShape): readonly LinkHandle[] {
  const middle = rowMiddle(shape.row);
  const blocks = shape.kind === 'task' ? shape.segments.slice(0, -1) : [];
  return [
    ...blocks.map((segment, block) => ({
      block,
      center: { x: segment.x + segment.width, y: middle },
    })),
    wholeTaskHandle(shape),
  ];
}

/** Returns the handle drawn after a bar, which stands for the end of the whole task. */
function wholeTaskHandle(shape: RowShape): LinkHandle {
  const end = shape.kind === 'milestone' ? shape.x + MILESTONE_SIZE / HALF : shape.end;
  return { block: null, center: { x: end + LINK_HANDLE_GAP, y: rowMiddle(shape.row) } };
}

/** Returns the centre of the handle of a block from which a link is dragged, the handle after the bar standing for the whole task and for a block the shape does not show. */
export function linkHandleCenter(shape: RowShape, block: number | null): Point {
  const handle = linkHandles(shape).find((candidate) => candidate.block === block);
  return (handle ?? wholeTaskHandle(shape)).center;
}

/** Returns the block of a split task that a link dropped at a position waits for: the block under it or the nearest one, the first block standing for the whole task. */
export function targetBlockAt(shape: RowShape, x: number): number | null {
  if (shape.kind !== 'task' || shape.segments.length < 2) {
    return null;
  }
  const distances = shape.segments.map((segment) =>
    Math.max(segment.x - x, x - (segment.x + segment.width), 0),
  );
  const nearest = distances.indexOf(Math.min(...distances));
  return nearest <= 0 ? null : nearest;
}

/** Finds what a pointer on the timeline would drag: a link handle of the selected task, the end of a work task bar to stretch it, a later block of a split task to move it alone, or a bar or milestone to move it. */
export function gestureAt(
  shape: RowShape | null,
  x: number,
  y: number,
  selectedTaskId: TaskId | null,
): GestureTarget | null {
  if (shape === null || shape.kind === 'summary') {
    return null;
  }
  const handleReach = LINK_HANDLE_RADIUS + HALF;
  const handle =
    shape.taskId === selectedTaskId
      ? linkHandles(shape).find(
          ({ center }) => Math.hypot(x - center.x, y - center.y) <= handleReach,
        )
      : undefined;
  if (handle !== undefined) {
    return { kind: 'link', taskId: shape.taskId, shape, block: handle.block };
  }
  const middle = rowMiddle(shape.row);
  if (Math.abs(y - middle) > Math.max(BAR_HEIGHT, MILESTONE_SIZE) / HALF) {
    return null;
  }
  const target = { taskId: shape.taskId, shape, block: null };
  if (shape.kind === 'milestone') {
    return Math.abs(x - shape.x) <= MILESTONE_SIZE / HALF ? { kind: 'move', ...target } : null;
  }
  if (Math.abs(x - shape.end) <= STRETCH_ZONE) {
    return { kind: 'stretch', ...target };
  }
  if (x < shape.start || x > shape.end) {
    return null;
  }
  return { kind: 'move', ...target, block: grabbedBlock(shape, x) };
}

/** Returns the block of a split task grabbed at a position, the first block or a pause standing for the whole task. */
function grabbedBlock(shape: Extract<RowShape, { kind: 'task' }>, x: number): number | null {
  const block = shape.segments.findIndex(
    (segment) => x >= segment.x && x <= segment.x + segment.width,
  );
  return block > 0 ? block : null;
}

/** Rounds an instant to the nearest multiple of a snap unit, such as the quarter hour or the day. */
export function snapHour(hour: number, snap: number): ProjectHour {
  return Math.round(hour / snap) * snap;
}

/** Returns the instant a moved bar asks to start at: its start shifted by the drag, aligned to the snap unit, a day-long unit keeping the bar on the day it was dropped on. */
export function movedStart(
  frame: TimelineFrame,
  start: ProjectHour,
  offset: number,
  snap: number,
): ProjectHour {
  const shifted = start + offset / frame.pixelsPerHour;
  return snap === HOURS_PER_DAY ? Math.floor(shifted / snap) * snap : snapHour(shifted, snap);
}

/** Returns the instant a stretched bar asks to end at: its end shifted by the drag and aligned to the snap unit. */
export function stretchedEnd(
  frame: TimelineFrame,
  end: ProjectHour,
  offset: number,
  snap: number,
): ProjectHour {
  return snapHour(end + offset / frame.pixelsPerHour, snap);
}
