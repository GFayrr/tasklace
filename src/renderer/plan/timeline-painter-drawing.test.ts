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
import type { DragPreview, PlacedShape } from './timeline-gestures';
import { linkHandles } from './timeline-gestures';
import {
  BAR_HEIGHT,
  dependencyArrow,
  MILESTONE_SIZE,
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
const FRAME = timelineFrame(PLAN.startDate, SCHEDULE, at(2026, 9, 30, 12), 4, []);
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
    deadlines: null,
    baseline: null,
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

/** Returns the shape of a task or milestone, failing the test for a summary. */
function placedShapeOf(id: string): PlacedShape {
  const shape = shapeOf(id);
  if (shape.kind === 'summary') {
    throw new Error(`${id} is a summary`);
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

  it('outlines a milestone that misses one of its dates with the error color', () => {
    const shape = placedShapeOf('n');
    const x = shape.kind === 'milestone' ? shape.x : Number.NaN;
    const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    const reach = MILESTONE_SIZE / 2 + 2;
    const calls = paintBody({ conflictTaskIds: new Set(['n']) });
    const outline = callsOf(calls, 'stroke').filter(
      (call) => call.strokeStyle === THEME.error && call.lineWidth === 2,
    );
    expect(outline).toHaveLength(1);
    const [stroke] = outline;
    if (stroke === undefined) {
      throw new Error('No outline');
    }
    const end = calls.indexOf(stroke);
    expect(
      calls.slice(end - 6, end + 1).map((call) => [call.name, ...call.args].join(' ')),
    ).toEqual([
      'beginPath',
      `moveTo ${String(x)} ${String(middle - reach)}`,
      `lineTo ${String(x + reach)} ${String(middle)}`,
      `lineTo ${String(x)} ${String(middle + reach)}`,
      `lineTo ${String(x - reach)} ${String(middle)}`,
      'closePath',
      'stroke',
    ]);
  });

  it('draws each deadline as a line across its row under a triangle, in red when missed, only when shown', () => {
    const DEADLINES = new Map([
      ['c', at(2026, 10, 1, 12)],
      ['n', at(2026, 10, 5, 9)],
    ]);
    const dated: Project = {
      ...PLAN,
      tasks: PLAN.tasks.map((task) => {
        const deadline = DEADLINES.get(task.id);
        return task.kind === 'summary' || deadline === undefined ? task : { ...task, deadline };
      }),
    };
    const outline = buildPlanOutline(dated.tasks, new Set());
    const scene = { rows: outline.rows, rowIndexById: outline.rowIndexById };
    /** Returns where the deadline mark of a task is drawn and its color. */
    const lineOf = (id: string, deadline: ProjectHour, color: string) => {
      const top = (outline.rowIndexById.get(id) ?? -1) * ROW_HEIGHT;
      return { x: xOf(FRAME, deadline), top, color };
    };
    const marks = [
      lineOf('c', at(2026, 10, 1, 12), THEME.action),
      lineOf('n', at(2026, 10, 5, 9), THEME.error),
    ];
    const calls = paintBody({
      ...scene,
      deadlines: { missedTaskIds: new Set(['n']) },
    });
    /** Tells whether a drawing call draws a deadline mark. */
    const isMark = (call: CanvasCall) =>
      call.name === 'fillRect' && call.args[2] === 2 && call.args[3] === ROW_HEIGHT - 4;
    const drawnMarks = calls.flatMap((call, index) =>
      isMark(call)
        ? [
            calls
              .slice(index, index + 7)
              .map((step) => [step.name, ...step.args, step.fillStyle].join(' ')),
          ]
        : [],
    );
    expect(drawnMarks).toEqual(
      marks.map(({ x, top, color }) => [
        `fillRect ${String(x - 1)} ${String(top + 2)} 2 ${String(ROW_HEIGHT - 4)} ${color}`,
        `beginPath ${color}`,
        `moveTo ${String(x - 5)} ${String(top + 2)} ${color}`,
        `lineTo ${String(x + 5)} ${String(top + 2)} ${color}`,
        `lineTo ${String(x)} ${String(top + 8)} ${color}`,
        `closePath ${color}`,
        `fill ${color}`,
      ]),
    );
    const lastBar = calls.findLastIndex((call) => call.name === 'stroke');
    expect(calls.findIndex(isMark)).toBeGreaterThan(lastBar);
    const below = paintBody(
      { ...scene, deadlines: { missedTaskIds: new Set(['n']) } },
      { ...VIEWPORT, top: (outline.rowIndexById.get('c') ?? -1) * ROW_HEIGHT + ROW_HEIGHT },
    );
    expect(
      callsOf(below, 'fillRect')
        .filter(isMark)
        .map((call) => call.fillStyle),
    ).toEqual([THEME.error]);
    const hidden = paintBody(scene);
    expect(
      callsOf(hidden, 'fillRect').filter(
        (call) => call.args[2] === 2 && call.args[3] === ROW_HEIGHT - 4,
      ),
    ).toEqual([]);
  });

  it('draws the baseline of each visible task as a thin pale bar at the top of its row, and a hollow diamond for a frozen instant', () => {
    const entries = new Map([
      [
        'c',
        { taskId: 'c', start: at(2026, 9, 29, 9), end: at(2026, 9, 30, 17), durationHours: 14 },
      ],
      ['n', { taskId: 'n', start: at(2026, 10, 1, 9), end: at(2026, 10, 1, 9), durationHours: 0 }],
    ]);
    /** Returns the top of the row of a task on the timeline. */
    const rowTop = (id: string) => (OUTLINE.rowIndexById.get(id) ?? -1) * ROW_HEIGHT;
    /** Returns the top of the ghost bar of a task on the timeline. */
    const ghostTop = (id: string) => rowTop(id) + 2;
    const pale = paleColor(THEME.textSecondary);
    const calls = paintBody({ baseline: entries });
    const ghosts = callsOf(calls, 'fillRect').filter(
      (call) => call.fillStyle === pale && call.args[3] === 3,
    );
    expect(ghosts.map((call) => call.args)).toEqual([
      [
        xOf(FRAME, at(2026, 9, 29, 9)),
        ghostTop('c'),
        xOf(FRAME, at(2026, 9, 30, 17)) - xOf(FRAME, at(2026, 9, 29, 9)),
        3,
      ],
    ]);
    const x = xOf(FRAME, at(2026, 10, 1, 9));
    const middle = ghostTop('n') + 1.5;
    const start = calls.findIndex(
      (call) => call.name === 'moveTo' && call.args[0] === x && call.args[1] === middle - 3,
    );
    expect(
      calls.slice(start - 1, start + 7).map((call) => [call.name, ...call.args].join(' ')),
    ).toEqual([
      'beginPath',
      `moveTo ${String(x)} ${String(middle - 3)}`,
      `lineTo ${String(x + 3)} ${String(middle)}`,
      `lineTo ${String(x)} ${String(middle + 3)}`,
      `lineTo ${String(x - 3)} ${String(middle)}`,
      'closePath',
      'fill',
      'stroke',
    ]);
    expect([
      calls[start + 5]?.fillStyle,
      calls[start + 6]?.strokeStyle,
      calls[start + 6]?.lineWidth,
    ]).toEqual([THEME.surface, THEME.textSecondary, 1.5]);
    const firstBar = calls.findIndex((call) => call.fillStyle === paleColor(THEME.bar));
    const [ghost] = ghosts;
    if (ghost === undefined) {
      throw new Error('No ghost');
    }
    expect(calls.indexOf(ghost)).toBeLessThan(firstBar);
    expect(callsOf(paintBody(), 'fillRect').filter((call) => call.fillStyle === pale)).toEqual([]);
  });

  it('draws a ghost at least two pixels wide, and only for the visible rows', () => {
    const instant = at(2026, 9, 29, 9);
    const entries = new Map([
      ['a', { taskId: 'a', start: instant, end: instant + 0.25, durationHours: 0.25 }],
      ['w', { taskId: 'w', start: instant, end: instant + 1, durationHours: 1 }],
    ]);
    const pale = paleColor(THEME.textSecondary);
    const below = { ...VIEWPORT, top: ((OUTLINE.rowIndexById.get('a') ?? -1) + 1) * ROW_HEIGHT };
    /** Lists the left edges of the ghost bars drawn in a viewport. */
    const ghosts = (viewport: Viewport) =>
      callsOf(paintBody({ baseline: entries }, viewport), 'fillRect')
        .filter((call) => call.fillStyle === pale && call.args[3] === 3)
        .map((call) => call.args[2]);
    expect(ghosts(VIEWPORT)).toEqual([2, xOf(FRAME, instant + 1) - xOf(FRAME, instant)]);
    expect(ghosts(below)).toEqual([xOf(FRAME, instant + 1) - xOf(FRAME, instant)]);
  });

  it('underlines the blocks of critical tasks in graphite and draws the float of the others as a dashed line', () => {
    const critical: Project = {
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
    };
    const schedule = scheduleOrThrow(critical);
    const floats = schedule.floats;
    if (floats === null) {
      throw new Error('No floats');
    }
    const calls = paintBody({ schedule });
    const marks = callsOf(calls, 'fillRect').filter(
      (call) => call.fillStyle === THEME.action && call.args[3] === 3,
    );
    const criticalBlocks = [...floats]
      .filter(([, taskFloat]) => taskFloat.isCritical)
      .map(([id]) => {
        const shape = placedShapeOf(id);
        return shape.kind === 'task' ? shape.segments.length : 1;
      })
      .reduce((sum, count) => sum + count, 0);
    expect([...floats].filter(([, taskFloat]) => taskFloat.isCritical).map(([id]) => id)).toEqual([
      'w',
    ]);
    expect(criticalBlocks).toBe(1);
    expect(marks).toHaveLength(criticalBlocks);
    const c = taskShapeOf('c');
    const cFloat = floats.get('c');
    expect(cFloat?.isCritical).toBe(false);
    const dashed = callsOf(calls, 'stroke').filter((call) => call.lineDash.join() === '4,3');
    const slipping = [...floats.values()].filter(
      (taskFloat) => !taskFloat.isCritical && taskFloat.totalFloatHours > 0,
    );
    expect(slipping).toHaveLength(5);
    expect(dashed.map((call) => [call.strokeStyle, call.lineWidth])).toEqual(
      slipping.map(() => [THEME.textSecondary, 1.5]),
    );
    const middle = (OUTLINE.rowIndexById.get('c') ?? -1) * ROW_HEIGHT + ROW_HEIGHT / 2;
    const cEnd = (c.segments.at(-1)?.x ?? 0) + (c.segments.at(-1)?.width ?? 0);
    expect(
      callsOf(calls, 'moveTo').some((call) => call.args[0] === cEnd && call.args[1] === middle),
    ).toBe(true);
    expect(
      callsOf(calls, 'lineTo').some(
        (call) => call.args[0] === xOf(FRAME, cFloat?.lateFinish ?? 0) && call.args[1] === middle,
      ),
    ).toBe(true);
    const plain = paintBody();
    expect(
      callsOf(plain, 'fillRect').some(
        (call) => call.fillStyle === THEME.action && call.args[3] === 3,
      ),
    ).toBe(false);
    expect(callsOf(plain, 'stroke').some((call) => call.lineDash.join() === '4,3')).toBe(false);
  });

  it('underlines a critical milestone across its diamond', () => {
    const m = placedShapeOf('m');
    const floats = new Map([
      [
        'm',
        { lateStart: 0, lateFinish: 0, totalFloatHours: 0, freeFloatHours: 0, isCritical: true },
      ],
    ]);
    const calls = paintBody({ schedule: { ...SCHEDULE, floats } });
    const top = (OUTLINE.rowIndexById.get('m') ?? -1) * ROW_HEIGHT;
    expect(
      callsOf(calls, 'fillRect')
        .filter((call) => call.fillStyle === THEME.action && call.args[3] === 3)
        .map((call) => call.args),
    ).toEqual([
      [
        (m.kind === 'milestone' ? m.x : Number.NaN) - MILESTONE_SIZE / 2,
        top + (ROW_HEIGHT + BAR_HEIGHT) / 2 + 2,
        MILESTONE_SIZE,
        3,
      ],
    ]);
  });

  it('underlines a task whose float is unknown as critical without any dashed line, and draws no float that ends exactly where the bar does', () => {
    const critical: Project = {
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
    };
    const schedule = scheduleOrThrow(critical);
    const unknown = {
      lateStart: null,
      lateFinish: null,
      totalFloatHours: null,
      freeFloatHours: null,
      isCritical: true,
    } as const;
    const floats = new Map([['c', unknown]]);
    const calls = paintBody({ schedule: { ...schedule, floats } });
    const c = taskShapeOf('c');
    expect(
      callsOf(calls, 'fillRect')
        .filter((call) => call.fillStyle === THEME.action && call.args[3] === 3)
        .map((call) => [call.args[0], call.args[2]]),
    ).toEqual(c.segments.map((segment) => [segment.x, segment.width]));
    expect(callsOf(calls, 'stroke').some((call) => call.lineDash.join() === '4,3')).toBe(false);
    const early = new Map(
      [...(schedule.floats ?? [])].map(([id]) => {
        const placement = schedule.placements.get(id);
        return [
          id,
          {
            lateStart: placement?.start ?? 0,
            lateFinish: placement?.end ?? 0,
            totalFloatHours: 1,
            freeFloatHours: 0,
            isCritical: false,
          },
        ];
      }),
    );
    const none = paintBody({ schedule: { ...schedule, floats: early } });
    expect(callsOf(none, 'stroke').some((call) => call.lineDash.join() === '4,3')).toBe(false);
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
    /** Returns the rectangle covering a period over the whole height of the viewport. */
    const span = (from: ProjectHour, to: ProjectHour) => [
      xOf(FRAME, from),
      0,
      xOf(FRAME, to) - xOf(FRAME, from),
      VIEWPORT.height,
    ];
    /** Returns an hour of the reference day. */
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

  it('outlines where a moved milestone would go', () => {
    const moved = dashed({ kind: 'move', shape: placedShapeOf('m'), offset: 12, block: null });
    expect(callsOf(moved, 'closePath')).toHaveLength(1);
    expect(callsOf(moved, 'strokeRect')).toEqual([]);
  });

  it('draws a dragged link to the pointer, framing the row and block it would be dropped on', () => {
    const target = taskShapeOf('b');
    const calls = dashed({
      kind: 'link',
      shape: placedShapeOf('c'),
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
      shape: placedShapeOf('c'),
      block: null,
      pointer: { x: 10, y: 10 },
      target: { row: shapeOf('m').row, end: { taskId: 'm', block: 0 } },
    });
    expect(callsOf(over, 'strokeRect')).toHaveLength(1);
    const nowhere = dashed({
      kind: 'link',
      shape: placedShapeOf('c'),
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
