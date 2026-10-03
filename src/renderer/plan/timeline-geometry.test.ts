import { describe, expect, it } from 'vitest';
import {
  blockLink,
  link,
  milestone,
  PROJECT_START,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { at } from '../../core/testing/civil-time';
import { buildPlanOutline } from './plan-outline';
import {
  ARROW_GAP,
  dependencyArrow,
  hourAt,
  rowMiddle,
  rowShape,
  ROW_HEIGHT,
  timelineFrame,
  xOf,
  type RowShape,
} from './timeline-geometry';

const PLAN = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's', sortKey: 'a', progressPercent: 50 }),
    splitTask(
      'b',
      [
        [7, 0],
        [7, 2],
      ],
      { parentId: 's', sortKey: 'b', progressPercent: 75 },
    ),
    milestone('m', { sortKey: 'b' }),
  ],
  [link('a', 'b'), link('b', 'm')],
);
const SCHEDULE = scheduleOrThrow(PLAN);
const OUTLINE = buildPlanOutline(PLAN.tasks, new Set());
const FRAME = timelineFrame(PLAN.startDate, SCHEDULE, PROJECT_START, 1);

/** Returns the shape of the row showing a task. */
function shapeOf(id: string): RowShape {
  const index = OUTLINE.rowIndexById.get(id) ?? -1;
  const row = OUTLINE.rows[index];
  const shape = row === undefined ? null : rowShape(row, index, SCHEDULE, FRAME);
  if (shape === null) {
    throw new Error(`No shape for ${id}`);
  }
  return shape;
}

describe('timelineFrame', () => {
  it('starts a week before the project at midnight and ends a month after the last task', () => {
    expect(FRAME.origin).toBe(at(2026, 9, 21));
    const last = Math.max(...[...SCHEDULE.placements.values()].map((placement) => placement.end));
    expect(FRAME.end).toBeGreaterThan(last);
    expect(xOf(FRAME, hourAt(FRAME, 123))).toBe(123);
  });

  it('never grows wider than a canvas can scroll', () => {
    const frame = timelineFrame(PLAN.startDate, SCHEDULE, at(2199, 1, 1), 36);
    expect(xOf(frame, frame.end)).toBeLessThanOrEqual(2 ** 24);
  });
});

describe('timelineFrame before the schedule is known', () => {
  it('covers at least two months from a week before the project', () => {
    const frame = timelineFrame(PLAN.startDate, null, PLAN.startDate, 1);
    expect(frame.origin).toBe(at(2026, 9, 21));
    expect(frame.end - frame.origin).toBeGreaterThanOrEqual(60 * 24);
  });
});

describe('rows without dates', () => {
  it('draws nothing for a task or summary the schedule does not place', () => {
    const empty = { ...SCHEDULE, placements: new Map(), summaries: new Map() };
    for (const id of ['s', 'a']) {
      const index = OUTLINE.rowIndexById.get(id) ?? -1;
      const row = OUTLINE.rows[index];
      if (row === undefined) {
        throw new Error(id);
      }
      expect(rowShape(row, index, empty, FRAME)).toBeNull();
    }
  });
});

describe('rowShape', () => {
  it('draws a work task block by block, filling its progress in order by duration', () => {
    const shape = shapeOf('b');
    expect(shape.kind).toBe('task');
    if (shape.kind !== 'task') {
      return;
    }
    const placement = SCHEDULE.placements.get('b');
    expect(shape.segments.map((segment) => segment.x)).toEqual(
      placement?.segments.map((segment) => xOf(FRAME, segment.start)),
    );
    const [first, second] = shape.segments;
    expect(first?.filled).toBe(first?.width);
    expect(second?.filled).toBeCloseTo((second?.width ?? 0) / 2);
  });

  it('draws a milestone at its date and a summary over its children', () => {
    const milestoneShape = shapeOf('m');
    expect(milestoneShape).toMatchObject({
      kind: 'milestone',
      x: xOf(FRAME, SCHEDULE.placements.get('m')?.start ?? 0),
    });
    const summaryShape = shapeOf('s');
    expect(summaryShape).toMatchObject({
      kind: 'summary',
      start: xOf(FRAME, SCHEDULE.placements.get('a')?.start ?? 0),
      end: xOf(FRAME, SCHEDULE.placements.get('b')?.end ?? 0),
    });
  });
});

describe('dependencyArrow', () => {
  it('goes from the end of the predecessor to the start of the successor', () => {
    const from = shapeOf('a');
    const to = shapeOf('b');
    const points = dependencyArrow(link('a', 'b'), from, to);
    expect(points[0]).toEqual({ x: from.kind === 'task' ? from.end : 0, y: rowMiddle(from.row) });
    expect(points.at(-1)).toEqual({ x: to.kind === 'task' ? to.start : 0, y: rowMiddle(to.row) });
  });

  it('goes around the bars when the successor starts before the predecessor ends', () => {
    const from = shapeOf('b');
    const to = shapeOf('a');
    const points = dependencyArrow(link('b', 'a', 'startToStart'), to, from);
    expect(points).toHaveLength(4);
    const backwards = dependencyArrow(link('b', 'a'), from, to);
    expect(backwards).toHaveLength(6);
    expect(backwards[2]?.y).toBe((to.row + 1) * ROW_HEIGHT);
    expect(backwards.at(-2)?.x).toBe((to.kind === 'task' ? to.start : 0) - ARROW_GAP);
  });

  it('leaves the end of the block a link names, and enters the start of a named block', () => {
    const from = shapeOf('b');
    const to = shapeOf('m');
    const [first, second] = from.kind === 'task' ? from.segments : [];
    const leaving = dependencyArrow(blockLink('b', 'm', { from: 0 }), from, to);
    expect(leaving[0]?.x).toBe((first?.x ?? 0) + (first?.width ?? 0));
    const entering = dependencyArrow(blockLink('a', 'b', { to: 1 }), shapeOf('a'), from);
    expect(entering.at(-1)?.x).toBe(second?.x);
  });

  it('falls back on the edge of the whole bar for a block the shape does not show', () => {
    const from = shapeOf('b');
    const points = dependencyArrow(blockLink('b', 'm', { from: 7 }), from, shapeOf('m'));
    expect(points[0]?.x).toBe(from.kind === 'task' ? from.end : 0);
  });

  it('enters the end of the successor for finish-to-finish links', () => {
    const from = shapeOf('a');
    const to = shapeOf('m');
    const points = dependencyArrow(link('a', 'm', 'finishToFinish'), from, to);
    expect(points.at(-1)?.x).toBe(to.kind === 'milestone' ? to.x + 8 : 0);
  });
});
