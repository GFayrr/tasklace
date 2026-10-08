import { describe, expect, it } from 'vitest';
import { at } from '../../core/testing/civil-time';
import {
  gestureAt,
  LINK_HANDLE_GAP,
  linkHandleCenter,
  linkHandles,
  movedStart,
  snapHour,
  STRETCH_ZONE,
  stretchedEnd,
  targetBlockAt,
} from './timeline-gestures';
import {
  MILESTONE_SIZE,
  ROW_HEIGHT,
  rowMiddle,
  type RowShape,
  type TimelineFrame,
} from './timeline-geometry';

const TASK: RowShape = {
  kind: 'task',
  taskId: 't',
  row: 2,
  segments: [{ x: 100, width: 80, filled: 0 }],
  start: 100,
  end: 180,
};
const SPLIT: RowShape = {
  kind: 'task',
  taskId: 't',
  row: 2,
  segments: [
    { x: 100, width: 40, filled: 0 },
    { x: 200, width: 60, filled: 0 },
  ],
  start: 100,
  end: 260,
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
    const handle = linkHandleCenter(TASK, null);
    expect(handle).toEqual({ x: 180 + LINK_HANDLE_GAP, y: MIDDLE });
    expect(gestureAt(TASK, handle.x, handle.y, 't')?.kind).toBe('link');
    expect(gestureAt(TASK, handle.x, handle.y, null)).toBeNull();
  });

  it('links from the end of each block of a split task, the last handle standing for the whole task', () => {
    expect(linkHandles(SPLIT).map(({ block, center }) => [block, center.x])).toEqual([
      [0, 140],
      [null, 260 + LINK_HANDLE_GAP],
    ]);
    expect(gestureAt(SPLIT, 140, MIDDLE, 't')).toMatchObject({ kind: 'link', block: 0 });
    expect(gestureAt(SPLIT, 260 + LINK_HANDLE_GAP, MIDDLE, 't')).toMatchObject({
      kind: 'link',
      block: null,
    });
    expect(gestureAt(SPLIT, 140, MIDDLE, null)?.kind).toBe('move');
  });

  it('moves a later block alone, and the whole task from its first block or a pause', () => {
    expect(gestureAt(SPLIT, 230, MIDDLE, null)).toMatchObject({ kind: 'move', block: 1 });
    expect(gestureAt(SPLIT, 120, MIDDLE, null)).toMatchObject({ kind: 'move', block: null });
    expect(gestureAt(SPLIT, 170, MIDDLE, null)).toMatchObject({ kind: 'move', block: null });
    expect(gestureAt(TASK, 120, MIDDLE, null)).toMatchObject({ kind: 'move', block: null });
  });

  it('drops a link on the nearest block, the first block standing for the whole task', () => {
    expect(targetBlockAt(SPLIT, 120)).toBeNull();
    expect(targetBlockAt(SPLIT, 230)).toBe(1);
    expect(targetBlockAt(SPLIT, 190)).toBe(1);
    expect(targetBlockAt(SPLIT, 150)).toBeNull();
    expect(targetBlockAt(TASK, 150)).toBeNull();
    expect(targetBlockAt(MILESTONE, 300)).toBeNull();
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

describe('handles of milestones and missing blocks', () => {
  it('gives a milestone a single handle after its diamond, standing for the whole task', () => {
    expect(linkHandles(MILESTONE)).toEqual([
      {
        block: null,
        center: { x: 300 + MILESTONE_SIZE / 2 + LINK_HANDLE_GAP, y: rowMiddle(3) },
      },
    ]);
  });

  it('places the handle of a block the shape does not show after the whole bar', () => {
    expect(linkHandleCenter(SPLIT, 7)).toEqual(linkHandleCenter(SPLIT, null));
  });

  it('grabs a milestone only on its diamond', () => {
    const middle = rowMiddle(3);
    expect(gestureAt(MILESTONE, 300 + MILESTONE_SIZE / 2, middle, null)).toMatchObject({
      kind: 'move',
    });
    expect(gestureAt(MILESTONE, 300 + MILESTONE_SIZE, middle, null)).toBeNull();
  });
});
