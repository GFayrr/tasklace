import type { TaskId } from '../../core/model/project';
import { HOURS_PER_DAY, type ProjectHour } from '../../core/time';
import {
  BAR_HEIGHT,
  MILESTONE_SIZE,
  ROW_HEIGHT,
  type RowShape,
  type TimelineFrame,
} from './timeline-geometry';

export type GestureKind = 'move' | 'stretch' | 'link';

export interface GestureTarget {
  readonly kind: GestureKind;
  readonly taskId: TaskId;
  readonly shape: RowShape;
}

export type DragPreview =
  | { readonly kind: 'move' | 'stretch'; readonly shape: RowShape; readonly offset: number }
  | {
      readonly kind: 'link';
      readonly shape: RowShape;
      readonly pointer: { readonly x: number; readonly y: number };
      readonly targetRow: number | null;
    };

export const LINK_HANDLE_RADIUS = 5;
export const LINK_HANDLE_GAP = 12;
export const STRETCH_ZONE = 6;
export const DRAG_THRESHOLD = 3;

const HALF = 2;

/** Returns the centre of the handle drawn after a bar, from which a link is dragged. */
export function linkHandleCenter(shape: RowShape): { readonly x: number; readonly y: number } {
  const end = shape.kind === 'milestone' ? shape.x + MILESTONE_SIZE / HALF : shape.end;
  return { x: end + LINK_HANDLE_GAP, y: shape.row * ROW_HEIGHT + ROW_HEIGHT / HALF };
}

/** Finds what a pointer on the timeline would drag: the link handle of the selected task, the end of a work task bar to stretch it, or a bar or milestone to move it. */
export function gestureAt(
  shape: RowShape | null,
  x: number,
  y: number,
  selectedTaskId: TaskId | null,
): GestureTarget | null {
  if (shape === null || shape.kind === 'summary') {
    return null;
  }
  const handle = linkHandleCenter(shape);
  const handleReach = LINK_HANDLE_RADIUS + HALF;
  if (shape.taskId === selectedTaskId && Math.hypot(x - handle.x, y - handle.y) <= handleReach) {
    return { kind: 'link', taskId: shape.taskId, shape };
  }
  const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / HALF;
  if (Math.abs(y - middle) > Math.max(BAR_HEIGHT, MILESTONE_SIZE) / HALF) {
    return null;
  }
  if (shape.kind === 'milestone') {
    return Math.abs(x - shape.x) <= MILESTONE_SIZE / HALF
      ? { kind: 'move', taskId: shape.taskId, shape }
      : null;
  }
  if (Math.abs(x - shape.end) <= STRETCH_ZONE) {
    return { kind: 'stretch', taskId: shape.taskId, shape };
  }
  return x >= shape.start && x <= shape.end ? { kind: 'move', taskId: shape.taskId, shape } : null;
}

/** Aligns an instant to the hour at the hour zoom, or to midnight of the nearest day otherwise. */
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
