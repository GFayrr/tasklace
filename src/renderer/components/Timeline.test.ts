import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import {
  milestone,
  project,
  scheduleOrThrow,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { buildPlanOutline } from '../plan/plan-outline';
import { tagStylesOf } from '../plan/tag-styles';
import { createScaleLabels } from '../plan/time-scale';
import { LINK_HANDLE_GAP } from '../plan/timeline-gestures';
import {
  BAR_HEIGHT,
  ROW_HEIGHT,
  rowShape,
  timelineFrame,
  type RowShape,
} from '../plan/timeline-geometry';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import Timeline from './Timeline.svelte';
import { render, single, update } from './testing/render';
import { drawFrames, pointer, refuseDrawingContexts, resize } from './testing/timeline-environment';

const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's' }),
    workTask('b', { sortKey: 'b' }),
    milestone('m', { sortKey: 'c' }),
  ],
  [],
);
const SCHEDULE = scheduleOrThrow(PLAN);
const OUTLINE = buildPlanOutline(PLAN.tasks, new Set());
const FRAME = timelineFrame(PLAN.startDate, SCHEDULE, at(2026, 9, 28, 12), 4);

/** Returns the shape of the row of a work task, failing the test for another kind. */
function shapeOf(id: string): Extract<RowShape, { kind: 'task' }> {
  const index = OUTLINE.rowIndexById.get(id) ?? -1;
  const row = OUTLINE.rows[index];
  const shape = row === undefined ? null : rowShape(row, index, SCHEDULE, FRAME);
  if (shape?.kind !== 'task') {
    throw new Error(id);
  }
  return shape;
}

/** Renders the timeline of the sample plan, sized, with recorded callbacks. */
function renderTimeline(selectedTaskId: string | null = null, scrollTop = 0, plan: Project = PLAN) {
  const calls = {
    scrolled: vi.fn(),
    resized: vi.fn(),
    select: vi.fn(),
    moved: vi.fn(),
    stretched: vi.fn(),
    linked: vi.fn(),
    opened: vi.fn(),
    drawingFailed: vi.fn(),
  };
  const scene = {
    frame: FRAME,
    zoom: 'day' as const,
    rows: plan === PLAN ? OUTLINE.rows : buildPlanOutline(plan.tasks, new Set()).rows,
    rowIndexById: OUTLINE.rowIndexById,
    schedule: SCHEDULE,
    dependencies: PLAN.dependencies,
    calendar: compileOrThrow(PLAN.calendar),
    nonWorkingPeriods: [],
    theme: SAND_GRAPHITE,
    tagStyles: tagStylesOf(plan),
    conflictTaskIds: new Set<string>(),
    selectedTaskId,
    today: at(2026, 9, 28, 12),
  };
  const root = render(Timeline, {
    scene,
    labels: createScaleLabels('en-US'),
    label: 'Timeline',
    scrollTop,
    scrollLeft: 0,
    ...calls,
  });
  const scroller = single(root, '.scroller');
  resize(scroller, 800, 300);
  return { root, scroller, calls };
}

/** Returns the vertical middle of the bar of a row. */
function middleOf(shape: RowShape): number {
  return shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

describe('Timeline', () => {
  it('reports its size and draws the scale and the visible rows once sized', () => {
    const { calls } = renderTimeline();
    expect(calls.resized).toHaveBeenCalledWith(800, 300);
    const drawing = drawFrames();
    expect(drawing.filter((call) => call.name === 'roundRect')).toHaveLength(4);
    expect(drawing.some((call) => call.name === 'fillText')).toBe(true);
    expect(drawFrames()).toEqual([]);
  });

  it('selects the task under the pointer and moves its bar where it is dropped', () => {
    const { scroller, calls } = renderTimeline();
    const shape = shapeOf('b');
    const x = shape.start + 4;
    pointer(scroller, 'pointerdown', x, middleOf(shape));
    expect(calls.select).toHaveBeenCalledWith('b');
    pointer(scroller, 'pointermove', x + 1, middleOf(shape));
    pointer(scroller, 'pointermove', x + 40, middleOf(shape));
    const preview = drawFrames().filter((call) => call.lineDash.join() === '4,3');
    expect(
      preview.some((call) => call.name === 'roundRect' && call.args[0] === shape.start + 40),
    ).toBe(true);
    pointer(scroller, 'pointerup', x + 40, middleOf(shape));
    expect(calls.moved).toHaveBeenCalledWith(shape, 40, null);
  });

  it('stretches a bar dragged by its end, and ignores a click that does not move', () => {
    const { scroller, calls } = renderTimeline();
    const shape = shapeOf('b');
    pointer(scroller, 'pointerdown', shape.end - 1, middleOf(shape));
    pointer(scroller, 'pointermove', shape.end + 20, middleOf(shape));
    pointer(scroller, 'pointerup', shape.end + 20, middleOf(shape));
    expect(calls.stretched).toHaveBeenCalledWith(shape, 21);
    pointer(scroller, 'pointerdown', shape.start + 4, middleOf(shape));
    pointer(scroller, 'pointerup', shape.start + 5, middleOf(shape));
    expect(calls.moved).not.toHaveBeenCalled();
  });

  it('links the selected task to the task it is dragged onto from its handle', () => {
    const { scroller, calls } = renderTimeline('a');
    const from = shapeOf('a');
    const to = shapeOf('b');
    const handleX = from.end + LINK_HANDLE_GAP;
    pointer(scroller, 'pointerdown', handleX, middleOf(from));
    expect(calls.select).not.toHaveBeenCalled();
    pointer(scroller, 'pointermove', to.start + 5, middleOf(to));
    expect(drawFrames().some((call) => call.name === 'strokeRect')).toBe(true);
    pointer(scroller, 'pointerup', to.start + 5, middleOf(to));
    expect(calls.linked).toHaveBeenCalledWith(
      { taskId: 'a', block: null },
      { taskId: 'b', block: null },
    );
  });

  it('links nothing when dropped on a summary, on the same task or off the rows', () => {
    const { scroller, calls } = renderTimeline('a');
    const from = shapeOf('a');
    const handleX = from.end + LINK_HANDLE_GAP;
    for (const y of [ROW_HEIGHT / 2, middleOf(from), 50 * ROW_HEIGHT]) {
      pointer(scroller, 'pointerdown', handleX, middleOf(from));
      pointer(scroller, 'pointermove', handleX + 30, y);
      pointer(scroller, 'pointerup', handleX + 30, y);
    }
    expect(calls.linked).not.toHaveBeenCalled();
  });

  it('abandons a drag that is cancelled, and ignores buttons other than the main one', () => {
    const { scroller, calls } = renderTimeline();
    const shape = shapeOf('b');
    pointer(scroller, 'pointerdown', shape.start + 4, middleOf(shape));
    pointer(scroller, 'pointermove', shape.start + 50, middleOf(shape));
    pointer(scroller, 'pointercancel', shape.start + 50, middleOf(shape));
    pointer(scroller, 'pointerup', shape.start + 50, middleOf(shape));
    pointer(scroller, 'pointerdown', shape.start + 4, middleOf(shape), 2);
    expect(calls.moved).not.toHaveBeenCalled();
    expect(calls.select).toHaveBeenCalledTimes(1);
  });

  it('shows what the pointer would drag with the cursor', () => {
    const { scroller } = renderTimeline();
    const shape = shapeOf('b');
    pointer(scroller, 'pointermove', shape.start + 4, middleOf(shape));
    expect(scroller.style.cursor).toBe('grab');
    pointer(scroller, 'pointermove', shape.end - 1, middleOf(shape));
    expect(scroller.style.cursor).toBe('ew-resize');
    pointer(scroller, 'pointermove', shape.end + 200, middleOf(shape) + BAR_HEIGHT);
    expect(scroller.style.cursor).toBe('default');
  });

  it('opens the details of the task whose row is double-clicked', () => {
    const { scroller, calls } = renderTimeline();
    scroller.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 5, clientY: middleOf(shapeOf('b')), bubbles: true }),
    );
    expect(calls.opened).toHaveBeenCalledWith('b');
    scroller.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 5, clientY: 80 * ROW_HEIGHT, bubbles: true }),
    );
    expect(calls.opened).toHaveBeenCalledTimes(1);
  });

  it('follows its own scroll, and scrolls to the position it is given', () => {
    const { scroller, calls } = renderTimeline(null, 40);
    update();
    expect(scroller.scrollTop).toBe(40);
    scroller.scrollTop = 12;
    scroller.dispatchEvent(new Event('scroll'));
    update();
    expect(calls.scrolled).toHaveBeenCalledWith(12, 0);
  });
});

describe('Timeline drawing conditions', () => {
  it('draws nothing before it has a size, and keeps the canvas size while it does not change', () => {
    const { root, scroller } = renderTimeline();
    drawFrames();
    const canvas = single(root, 'canvas.layer') as HTMLCanvasElement;
    const width = canvas.width;
    pointer(scroller, 'pointermove', 1, 1);
    drawFrames();
    expect(canvas.width).toBe(width);
    resize(scroller, 0, 0);
    pointer(scroller, 'pointermove', 2, 2);
    expect(drawFrames()).toEqual([]);
  });

  it('tells when the patterns of the bars cannot be drawn, the bars staying plain', () => {
    const design = {
      id: 'design',
      name: 'Design',
      color: '#3366AA',
      representsPersonOrTeam: false,
    };
    const patterned = project(
      [
        ...PLAN.tasks.filter((task) => task.id !== 'b'),
        workTask('b', { sortKey: 'b', tagId: 'design' }),
      ],
      [],
      {
        tags: [design],
        options: {
          criticalPathEnabled: false,
          dateConstraintsEnabled: false,
          alwaysShowPatterns: true,
        },
      },
    );
    const { calls } = renderTimeline(null, 0, patterned);
    drawFrames();
    expect(calls.drawingFailed).toHaveBeenCalledWith('patterns');
    expect(calls.drawingFailed).not.toHaveBeenCalledWith('timeline');
  });

  it('draws at the density of the screen, and skips a canvas without drawing context, telling so', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { root, calls } = renderTimeline();
    drawFrames();
    expect((single(root, 'canvas.layer') as HTMLCanvasElement).width).toBe(1_600);
    expect(calls.drawingFailed).not.toHaveBeenCalled();
    refuseDrawingContexts();
    resize(single(root, '.scroller'), 700, 300);
    expect(drawFrames()).toEqual([]);
    expect(calls.drawingFailed).toHaveBeenCalledWith('timeline');
  });

  it('starts no drag on an empty part of the timeline, and selects nothing below the rows', () => {
    const { scroller, calls } = renderTimeline();
    pointer(scroller, 'pointerdown', 5, 60 * ROW_HEIGHT);
    pointer(scroller, 'pointermove', 50, 60 * ROW_HEIGHT);
    pointer(scroller, 'pointerup', 50, 60 * ROW_HEIGHT);
    expect(calls.select).not.toHaveBeenCalled();
    const summaryMiddle = ROW_HEIGHT / 2;
    pointer(scroller, 'pointerdown', 5, summaryMiddle);
    expect(calls.select).toHaveBeenCalledWith('s');
  });
});
