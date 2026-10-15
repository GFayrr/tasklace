import { describe, expect, it } from 'vitest';
import type { TaskSegment, TaskSegments } from './model/project';
import { mapSegments, nonEmptySegments, withLastSegment } from './task-segments';

/** Builds a block of some hours, resuming some days after the previous one. */
function block(durationHours: number, gapDaysBefore = 0): TaskSegment {
  return { durationHours, gapDaysBefore, startNoEarlierThan: null };
}

const ONE: TaskSegments = [block(3)];
const THREE: TaskSegments = [block(3), block(4, 1), block(5, 2)];

describe('the blocks of a work task', () => {
  it('turns a list into blocks, refusing an empty one', () => {
    expect(nonEmptySegments([])).toBeNull();
    expect(nonEmptySegments([...THREE])).toEqual(THREE);
  });

  it('changes every block with its index, keeping their number', () => {
    expect(mapSegments(THREE, (segment, index) => ({ ...segment, durationHours: index }))).toEqual([
      block(0),
      block(1, 1),
      block(2, 2),
    ]);
    expect(mapSegments(ONE, (segment) => ({ ...segment, durationHours: 8 }))).toEqual([block(8)]);
  });

  it('changes the last block, a single block being both the first and the last', () => {
    expect(withLastSegment(THREE, (last) => ({ ...last, durationHours: 1 }))).toEqual([
      block(3),
      block(4, 1),
      block(1, 2),
    ]);
    expect(withLastSegment(ONE, (last) => ({ ...last, durationHours: 1 }))).toEqual([block(1)]);
  });
});
