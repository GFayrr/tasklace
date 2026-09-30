import { describe, expect, it } from 'vitest';
import { at } from '../../core/testing/civil-time';
import {
  gestureAt,
  LINK_HANDLE_GAP,
  linkHandleCenter,
  movedStart,
  snapHour,
  STRETCH_ZONE,
  stretchedEnd,
} from './timeline-gestures';
import { ROW_HEIGHT, type RowShape, type TimelineFrame } from './timeline-geometry';

const TASK: RowShape = {
  kind: 'task',
  taskId: 't',
  row: 2,
  segments: [{ x: 100, width: 80, filled: 0 }],
  start: 100,
  end: 180,
};
const MILESTONE: RowShape = { kind: 'milestone', taskId: 'm', row: 3, x: 300 };
const SUMMARY: RowShape = { kind: 'summary', taskId: 's', row: 0, start: 0, end: 400 };
const MIDDLE = 2 * ROW_HEIGHT + ROW_HEIGHT / 2;
const FRAME: TimelineFrame = { origin: at(2026, 10, 1), end: at(2026, 12, 1), pixelsPerHour: 2 };

describe('gestureAt', () => {
  it('moves a bar grabbed in its body and stretches it grabbed at its end', () => {
    expect(gestureAt(TASK, 120, MIDDLE, null)?.kind).toBe('move');
    expect(gestureAt(TASK, 180 + STRETCH_ZONE, MIDDLE, null)?.kind).toBe('stretch');
    expect(gestureAt(TASK, 60, MIDDLE, null)).toBeNull();
    expect(gestureAt(TASK, 120, 2 * ROW_HEIGHT + 1, null)).toBeNull();
  });

  it('links from the handle of the selected task only', () => {
    const handle = linkHandleCenter(TASK);
    expect(handle).toEqual({ x: 180 + LINK_HANDLE_GAP, y: MIDDLE });
    expect(gestureAt(TASK, handle.x, handle.y, 't')?.kind).toBe('link');
    expect(gestureAt(TASK, handle.x, handle.y, null)).toBeNull();
  });

  it('moves a milestone, and never drags a summary', () => {
    expect(gestureAt(MILESTONE, 304, 3 * ROW_HEIGHT + ROW_HEIGHT / 2, null)?.kind).toBe('move');
    expect(gestureAt(SUMMARY, 100, ROW_HEIGHT / 2, null)).toBeNull();
    expect(gestureAt(null, 0, 0, null)).toBeNull();
  });
});

describe('snapping', () => {
  it('aligns to the hour at the hour zoom', () => {
    expect(snapHour(10.4, 1)).toBe(10);
    expect(movedStart(FRAME, at(2026, 10, 5, 9), 7, 1)).toBe(at(2026, 10, 5, 13));
    expect(stretchedEnd(FRAME, at(2026, 10, 5, 17), -3, 1)).toBe(at(2026, 10, 5, 16));
  });

  it('keeps a moved bar on the day it is dropped on, and ends a stretched bar at a day boundary', () => {
    expect(movedStart(FRAME, at(2026, 10, 5, 9), 2 * 24 * 2, 24)).toBe(at(2026, 10, 7));
    expect(movedStart(FRAME, at(2026, 10, 5, 9), -2, 24)).toBe(at(2026, 10, 5));
    expect(stretchedEnd(FRAME, at(2026, 10, 5, 17), 2 * 24 * 2, 24)).toBe(at(2026, 10, 8));
  });
});
