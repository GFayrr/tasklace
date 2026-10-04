import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import type { ProjectHour } from '../../core/time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import { buildPlanOutline } from './plan-outline';
import { paleColor, tagStylesOf } from './tag-styles';
import { callsOf, recordingCanvas, type CanvasCall } from './testing/recording-canvas';
import type { DragPreview } from './timeline-gestures';
import { linkHandles } from './timeline-gestures';
import {
  BAR_HEIGHT,
  dependencyArrow,
  ROW_HEIGHT,
  rowShape,
  timelineFrame,
  xOf,
  type RowShape,
} from './timeline-geometry';
import {
  paintTimelineBody,
  paintTimelineHeader,
  previewSpan,
  type TimelineScene,
  type Viewport,
} from './timeline-painter';

const THEME = SAND_GRAPHITE;
const STRIPES = { kind: 'stripes' } as unknown as CanvasPattern;
const DESIGN = { id: 'design', name: 'Design', color: '#3366AA', representsPersonOrTeam: true };
const NEAR = { id: 'near', name: 'Near', color: '#3366AB', representsPersonOrTeam: false };
const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's', sortKey: 'a', progressPercent: 50, tagId: 'design' }),
    splitTask(
      'b',
      [
        [7, 0],
        [7, 2],
      ],
      { parentId: 's', sortKey: 'b', tagId: 'near' },
    ),
    workTask('c', { sortKey: 'b' }),
    milestone('m', { sortKey: 'c', tagId: 'design' }),
    milestone('n', { sortKey: 'd' }),
    workTask('w', {
      sortKey: 'e',
      segments: [{ durationHours: 14, gapDaysBefore: 0, startNoEarlierThan: null }],
      startNoEarlierThan: at(2026, 10, 2, 9),
    }),
  ],
  [link('a', 'b'), link('b', 'm')],
  { tags: [DESIGN, NEAR] },
);
const SCHEDULE = scheduleOrThrow(PLAN);
const OUTLINE = buildPlanOutline(PLAN.tasks, new Set());
const FRAME = timelineFrame(PLAN.startDate, SCHEDULE, at(2026, 9, 30, 12), 4);
const VIEWPORT: Viewport = { left: 0, top: 0, width: xOf(FRAME, FRAME.end), height: 600 };

/** Builds the scene of the sample plan, with any part replaced. */
function sceneOf(overrides: Partial<TimelineScene> = {}): TimelineScene {
  return {
    frame: FRAME,
    zoom: 'day',
    rows: OUTLINE.rows,
    rowIndexById: OUTLINE.rowIndexById,
    schedule: SCHEDULE,
    dependencies: PLAN.dependencies,
    calendar: compileOrThrow(PLAN.calendar),
    nonWorkingPeriods: [],
    theme: THEME,
    tagStyles: tagStylesOf(PLAN),
    conflictTaskIds: new Set(),
    selectedTaskId: null,
    today: at(2026, 9, 30, 12),
    preview: null,
    patternFor: () => STRIPES,
    ...overrides,
  };
}

/** Paints the body of a scene and returns the calls it made. */
function paintBody(overrides: Partial<TimelineScene> = {}, viewport = VIEWPORT): CanvasCall[] {
  const { context, calls } = recordingCanvas();
  paintTimelineBody(context, sceneOf(overrides), viewport);
  return calls;
}

/** Returns the shape of the row of a task in the sample plan. */
function shapeOf(id: string): RowShape {
  const index = OUTLINE.rowIndexById.get(id) ?? -1;
  const row = OUTLINE.rows[index];
  const shape = row === undefined ? null : rowShape(row, index, SCHEDULE, FRAME);
  if (shape === null) {
    throw new Error(`No shape for ${id}`);
  }
  return shape;
}

/** Returns the work task shape of a task, failing the test for another kind. */
function taskShapeOf(id: string): Extract<RowShape, { kind: 'task' }> {
  const shape = shapeOf(id);
  if (shape.kind !== 'task') {
    throw new Error(`${id} is not a work task`);
  }
  return shape;
}

/** Tells whether a rectangle was filled at a vertical position with a color. */
function filledAt(calls: readonly CanvasCall[], y: number, color: unknown): boolean {
  return callsOf(calls, 'fillRect').some((call) => call.args[1] === y && call.fillStyle === color);
}

describe('paintTimelineBody', () => {
  it('fills the background, shades days off and draws the today line in the error color', () => {
    const calls = paintBody();
    expect(callsOf(calls, 'fillRect')[0]).toMatchObject({
      args: [0, 0, VIEWPORT.width, VIEWPORT.height],
      fillStyle: THEME.surface,
    });
    expect(callsOf(calls, 'fillRect').some((call) => call.fillStyle === THEME.nonWorking)).toBe(
      true,
    );
    expect(callsOf(calls, 'fillRect').at(-1)).toMatchObject({
      args: [xOf(FRAME, at(2026, 9, 30, 12)) - 1, 0, 2, VIEWPORT.height],
      fillStyle: THEME.error,
    });
  });

  it('highlights the row of the selected task and draws a handle for each of its link ends', () => {
    const row = OUTLINE.rowIndexById.get('b') ?? -1;
    const calls = paintBody({ selectedTaskId: 'b' });
    expect(filledAt(calls, row * ROW_HEIGHT, THEME.selection)).toBe(true);
    expect(callsOf(calls, 'arc')).toHaveLength(linkHandles(shapeOf('b')).length);
  });

  it('draws no handle for a selected summary, and no selection for a task out of the plan', () => {
    expect(callsOf(paintBody({ selectedTaskId: 's' }), 'arc')).toEqual([]);
    const calls = paintBody({ selectedTaskId: 'gone' });
    expect(callsOf(calls, 'fillRect').some((call) => call.fillStyle === THEME.selection)).toBe(
      false,
    );
  });

  it('fills a bar with its tag color up to its progress, on its pale color, with its pattern', () => {
    const calls = paintBody();
    const shape = taskShapeOf('a');
    const barTop = shape.row * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    const fills = callsOf(calls, 'fillRect').filter((call) => call.args[1] === barTop);
    expect(fills.map((call) => call.fillStyle)).toEqual([paleColor(DESIGN.color), DESIGN.color]);
    const near = taskShapeOf('b');
    const nearTop = near.row * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    expect(filledAt(calls, nearTop, STRIPES)).toBe(true);
  });

  it('draws a bar without tag in the bar color, a milestone without tag in the text color, and the ends of a summary in the secondary text color', () => {
    const calls = paintBody();
    const plain = taskShapeOf('c');
    const plainTop = plain.row * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    expect(filledAt(calls, plainTop, paleColor(THEME.bar))).toBe(true);
    const diamonds = callsOf(calls, 'closePath').map((call) => call.fillStyle);
    expect(diamonds).toEqual([THEME.textSecondary, THEME.textSecondary, DESIGN.color, THEME.text]);
  });

  it('outlines the bars of a task in a conflict with the error color', () => {
    const outlined = paintBody({ conflictTaskIds: new Set(['a']) });
    const strokes = callsOf(outlined, 'stroke').filter(
      (call) => call.strokeStyle === THEME.error && call.lineWidth === 2,
    );
    expect(strokes).toHaveLength(1);
    const plain = paintBody();
    expect(callsOf(plain, 'stroke').some((call) => call.strokeStyle === THEME.error)).toBe(false);
  });

  it('joins the blocks of a split task with a dotted line in its color', () => {
    const calls = paintBody();
    const dotted = callsOf(calls, 'stroke').filter((call) => call.lineDash.join() === '2,3');
    expect(dotted.map((call) => call.strokeStyle)).toEqual([NEAR.color]);
  });

  it('draws the summary as a bar in the text color', () => {
    const shape = shapeOf('s');
    const calls = paintBody();
    expect(
      callsOf(calls, 'fillRect').some(
        (call) =>
          call.fillStyle === THEME.text &&
          call.args[0] === (shape.kind === 'summary' ? shape.start : -1),
      ),
    ).toBe(true);
  });

  it('draws each link from its predecessor, ending with an arrow head', () => {
    const calls = paintBody();
    for (const dependency of PLAN.dependencies) {
      const from = shapeOf(dependency.predecessorId);
      const to = shapeOf(dependency.successorId);
      const [first] = dependencyArrow(dependency, from, to);
      expect(
        callsOf(calls, 'moveTo').some(
          (call) => call.args[0] === first?.x && call.args[1] === first?.y,
        ),
      ).toBe(true);
    }
  });

  it('skips the links and bars of rows out of view, and links to tasks out of the plan', () => {
    const lastRow = OUTLINE.rows.length - 1;
    const bottom = { ...VIEWPORT, top: lastRow * ROW_HEIGHT, height: ROW_HEIGHT };
    const [first] = dependencyArrow(link('a', 'b'), shapeOf('a'), shapeOf('b'));
    const calls = paintBody({ dependencies: [...PLAN.dependencies, link('a', 'gone')] }, bottom);
    expect(
      callsOf(calls, 'moveTo').some(
        (call) => call.args[0] === first?.x && call.args[1] === first?.y,
      ),
    ).toBe(false);
  });

  it('draws only the background, shading and today line before the schedule is known', () => {
    const calls = paintBody({ schedule: null, calendar: null });
    expect(callsOf(calls, 'roundRect')).toEqual([]);
    expect(callsOf(calls, 'fillRect')).toHaveLength(2);
  });

  it('draws a block without calendar as a single part', () => {
    const calls = paintBody({ calendar: null });
    const shape = taskShapeOf('w');
    const barTop = shape.row * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    const parts = callsOf(calls, 'roundRect').filter((call) => call.args[1] === barTop);
    expect(parts.map((call) => call.args[0])).toEqual([shape.start]);
  });

  it('draws a block over a weekend as two parts joined by a thin pale band', () => {
    const calls = paintBody();
    const shape = taskShapeOf('w');
    const top = shape.row * ROW_HEIGHT;
    const barTop = top + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    expect(callsOf(calls, 'roundRect').filter((call) => call.args[1] === barTop)).toHaveLength(2);
    const band = callsOf(calls, 'fillRect').filter(
      (call) => call.args[1] === top + (ROW_HEIGHT - 6) / 2,
    );
    expect(band.map((call) => call.fillStyle)).toEqual([paleColor(THEME.bar)]);
  });

  it('shades the hours outside the working day at the hour zoom', () => {
    const day = { ...VIEWPORT, left: xOf(FRAME, at(2026, 9, 28)), width: 24 * 4 };
    const calls = paintBody({ zoom: 'hour' }, day);
    const shaded = callsOf(calls, 'fillRect').filter((call) => call.fillStyle === THEME.nonWorking);
    const span = (from: ProjectHour, to: ProjectHour) => [
      xOf(FRAME, from),
      0,
      xOf(FRAME, to) - xOf(FRAME, from),
      VIEWPORT.height,
    ];
    const hour = (value: number) => at(2026, 9, 28, value);
    expect(shaded.map((call) => call.args)).toEqual([
      span(hour(0), hour(9)),
      span(hour(12), hour(13)),
      span(hour(17), at(2026, 9, 29)),
    ]);
  });
});

describe('drag previews', () => {
  /** Paints a scene with a preview and returns the dashed calls it made. */
  function dashed(preview: DragPreview): CanvasCall[] {
    return paintBody({ preview }).filter((call) => call.lineDash.join() === '4,3');
  }

  it('outlines where a moved or stretched bar would go', () => {
    const shape = taskShapeOf('c');
    for (const preview of [
      { kind: 'move', shape, offset: 40, block: null },
      { kind: 'stretch', shape, offset: -10 },
    ] as const) {
      const span = previewSpan(shape, preview);
      const outline = callsOf(dashed(preview), 'roundRect');
      expect(outline.map((call) => [call.args[0], call.args[2]])).toEqual([
        [span.start, span.width],
      ]);
    }
  });

  it('outlines where a moved milestone would go, and draws nothing for a dragged summary', () => {
    const milestoneShape = shapeOf('m');
    const moved = dashed({ kind: 'move', shape: milestoneShape, offset: 12, block: null });
    expect(callsOf(moved, 'closePath')).toHaveLength(1);
    const summaryMove = dashed({ kind: 'move', shape: shapeOf('s'), offset: 12, block: null });
    expect(summaryMove.filter((call) => call.name !== 'save' && call.name !== 'restore')).toEqual(
      [],
    );
  });

  it('draws a dragged link to the pointer, framing the row and block it would be dropped on', () => {
    const target = taskShapeOf('b');
    const calls = dashed({
      kind: 'link',
      shape: shapeOf('c'),
      block: null,
      pointer: { x: 300, y: 50 },
      target: { row: target.row, end: { taskId: 'b', block: 1 } },
    });
    expect(
      callsOf(calls, 'lineTo').some((call) => call.args[0] === 300 && call.args[1] === 50),
    ).toBe(true);
    const frames = callsOf(calls, 'strokeRect');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.args[0]).toBe((target.segments[1]?.x ?? 0) - 3);
  });

  it('frames only the row of a dragged link over a task without that block, and nothing without a row', () => {
    const over = dashed({
      kind: 'link',
      shape: shapeOf('c'),
      block: null,
      pointer: { x: 10, y: 10 },
      target: { row: shapeOf('m').row, end: { taskId: 'm', block: 0 } },
    });
    expect(callsOf(over, 'strokeRect')).toHaveLength(1);
    const nowhere = dashed({
      kind: 'link',
      shape: shapeOf('c'),
      block: null,
      pointer: { x: 10, y: 10 },
      target: null,
    });
    expect(callsOf(nowhere, 'strokeRect')).toEqual([]);
  });
});

describe('paintTimelineHeader', () => {
  it('writes the labels that fit in their period and leaves out those that do not', () => {
    const { context, calls } = recordingCanvas();
    const ticks = {
      upper: [
        { start: at(2026, 9, 28), end: at(2026, 10, 5), label: 'Week 40' },
        { start: at(2026, 10, 5), end: at(2026, 10, 5, 2), label: 'Too long to fit here' },
      ],
      lower: [
        { start: at(2026, 9, 28), end: at(2026, 9, 29), label: 'M' },
        { start: at(2026, 9, 29), end: at(2026, 9, 29, 1), label: 'Tuesday the twenty-ninth' },
      ],
    };
    paintTimelineHeader(context, sceneOf(), { ...VIEWPORT, height: 48 }, ticks);
    expect(callsOf(calls, 'fillText').map((call) => call.args[0])).toEqual(['Week 40', 'M']);
    expect(callsOf(calls, 'fillRect')[0]).toMatchObject({ fillStyle: THEME.background });
  });
});
