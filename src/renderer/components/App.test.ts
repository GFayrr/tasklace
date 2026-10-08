import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { project, workTask } from '../../core/testing/project-builder';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import { AppState } from '../app/app-state.svelte';
import english from '../locales/en.json';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import { LINK_HANDLE_GAP } from '../plan/timeline-gestures';
import { TABLE_WIDTH_STEP } from '../plan/table-width';
import { pixelsPerHour, zoomedScrollLeft } from '../plan/time-scale';
import {
  ROW_HEIGHT,
  rowShape,
  timelineFrame,
  xOf,
  type RowShape,
  type TimelineFrame,
} from '../plan/timeline-geometry';
import { localHourOf } from '../project/new-project';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import App from './App.svelte';
import { press, render, single, update } from './testing/render';
import { drawFrames, pointer, refuseDrawingContexts, resize } from './testing/timeline-environment';

const PLAN: Project = project(
  [workTask('a', { name: 'Read' }), workTask('b', { sortKey: 'b', name: 'Write' })],
  [],
  {
    name: 'Thesis',
  },
);

/** Renders the whole interface, with the sample plan open when asked. */
async function renderApp(withPlan: boolean) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  if (withPlan) {
    fake.control.openResult = openedProjectOf(PLAN);
    await app.open();
  }
  const root = render(App, { app });
  return { app, root, ...fake };
}

describe('App', () => {
  it('welcomes the user without a project, and shows the workspace once one is open', async () => {
    const empty = await renderApp(false);
    expect(empty.root.querySelector('.welcome')).not.toBeNull();
    expect(empty.root.querySelector('.shell')).toBeNull();
    const opened = await renderApp(true);
    expect(opened.root.querySelector('.welcome')).toBeNull();
    expect(single(opened.root, '[role="grid"]').getAttribute('aria-label')).toBe(
      english.table.label,
    );
  });

  it('runs the global shortcuts, leaving undo to a text field being edited', async () => {
    const { app, root, control } = await renderApp(true);
    expect(press(window, 's', { ctrlKey: true })).toBe(false);
    await settle();
    expect(control.saved).toEqual([{ as: false, name: 'Thesis' }]);
    app.rename('Changed');
    await settle();
    const name = single(root, 'input.name');
    expect(press(name, 'z', { ctrlKey: true })).toBe(true);
    await settle();
    expect(app.project?.name).toBe('Changed');
    expect(press(document.body, 'z', { ctrlKey: true })).toBe(false);
    await settle();
    expect(app.project?.name).toBe('Thesis');
    expect(press(window, 'q', { ctrlKey: true })).toBe(true);
  });

  it('commits the cell being edited before a file shortcut, so that the save holds the typed value', async () => {
    const { app, root, control } = await renderApp(true);
    const grid = single(root, '[role="grid"]');
    app.select('a');
    update();
    press(grid, 'Enter');
    await settle();
    const input = single(root, 'input.editor') as HTMLInputElement;
    input.focus();
    input.value = 'Typed before saving';
    expect(press(input, 's', { ctrlKey: true })).toBe(false);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')?.name).toBe('Typed before saving');
    expect(app.notices).toEqual([]);
    expect(control.saved).toEqual([{ as: false, name: 'Thesis' }]);
    expect(root.querySelector('input.editor')).toBeNull();
  });

  it('makes the toolbar and the workspace inert and ignores the shortcuts while a file action runs', async () => {
    const { app, root, control, context } = await renderApp(true);
    const shell = single(root, '.shell');
    expect(shell.inert).toBe(false);
    expect(shell.getAttribute('aria-busy')).toBe('false');
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () =>
        new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        }),
    });
    const opening = app.open();
    await settle();
    update();
    expect(shell.inert).toBe(true);
    expect(shell.getAttribute('aria-busy')).toBe('true');
    expect(press(window, 'n', { ctrlKey: true })).toBe(true);
    await settle();
    expect(control.calls.filter((call) => call === 'newProject')).toEqual([]);
    finish({ ok: false, error: { code: 'CANCELLED' } });
    await opening;
    update();
    expect(shell.inert).toBe(false);
    expect(shell.getAttribute('aria-busy')).toBe('false');
  });

  it('leaves the shortcuts alone while a dialog is open', async () => {
    const { app, control } = await renderApp(true);
    app.openDetails('a');
    update();
    press(window, 'o', { ctrlKey: true });
    app.closeDetails();
    app.openReport({ title: 'T', entries: [] });
    update();
    press(window, 'o', { ctrlKey: true });
    await settle();
    expect(control.calls.filter((call) => call === 'openProject')).toHaveLength(1);
  });
});

describe('Workspace', () => {
  const TODAY = new Date(2026, 8, 28, 12);
  const SCROLLER_HEIGHT = 400;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Renders the interface with the sample plan, sized, and returns how the timeline places it. */
  async function renderSized() {
    const rendered = await renderApp(true);
    resize(single(rendered.root, 'main.workspace'), 1_200, 600);
    const scroller = single(rendered.root, '.scroller');
    resize(scroller, 800, SCROLLER_HEIGHT);
    const frame = timelineFrame(
      PLAN.startDate,
      rendered.app.schedule,
      localHourOf(TODAY),
      pixelsPerHour('day'),
      [],
    );
    const scrollLeft = xOf(frame, PLAN.startDate - 48);
    return { ...rendered, scroller, frame, scrollLeft };
  }

  /** Returns the shape of the bar of a task in the timeline. */
  function shapeIn(
    app: AppState,
    frame: TimelineFrame,
    id: string,
  ): Extract<RowShape, { kind: 'task' }> {
    const index = app.outline.rowIndexById.get(id) ?? -1;
    const row = app.outline.rows[index];
    const schedule = app.schedule;
    const shape =
      row === undefined || schedule === null ? null : rowShape(row, index, schedule, frame);
    if (shape?.kind !== 'task') {
      throw new Error(id);
    }
    return shape;
  }

  it('tells once that the timeline cannot be drawn when the canvas gives no drawing context', async () => {
    const { app, root } = await renderSized();
    drawFrames();
    expect(app.notices).toEqual([]);
    refuseDrawingContexts();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      resize(single(root, '.scroller'), 700, 400);
      drawFrames();
      resize(single(root, '.scroller'), 600, 400);
      drawFrames();
    } finally {
      logged.mockRestore();
    }
    expect(app.notices.map((notice) => notice.text)).toEqual([
      app.messages.notices.drawingUnavailable.timeline,
    ]);
  });

  it('works without remembering the width of the table where the storage of the browser is refused', async () => {
    const refused = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage refused', 'SecurityError');
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { root } = await renderSized();
      press(single(root, '[role="separator"]'), 'ArrowRight');
      expect(warned).toHaveBeenCalledWith(
        'The width of the table will not be remembered:',
        expect.any(DOMException),
      );
    } finally {
      warned.mockRestore();
      refused.mockRestore();
    }
  });

  it('moves the separator with the arrow keys and remembers the width of the table', async () => {
    const { root } = await renderSized();
    const separator = single(root, '[role="separator"]');
    const before = Number(separator.getAttribute('aria-valuenow'));
    expect(press(separator, 'ArrowRight')).toBe(false);
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(before + TABLE_WIDTH_STEP);
    press(separator, 'ArrowLeft');
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(before);
    expect(press(separator, 'Enter')).toBe(true);
    expect(localStorage.getItem('tasklace.taskTableWidth')).toBe(String(before));
  });

  it('follows the pointer while the separator is dragged, and stops when it is released', async () => {
    const { root } = await renderSized();
    const separator = single(root, '[role="separator"]');
    const before = Number(separator.getAttribute('aria-valuenow'));
    pointer(separator, 'pointerdown', 100, 10);
    pointer(separator, 'pointermove', 160, 10);
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(before + 60);
    pointer(separator, 'pointerup', 160, 10);
    pointer(separator, 'pointermove', 400, 10);
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(before + 60);
  });

  it('shows the project from two days before its start, and moves a dragged bar by whole days', async () => {
    const { app, scroller, frame, scrollLeft } = await renderSized();
    expect(scroller.scrollLeft).toBe(scrollLeft);
    const shape = shapeIn(app, frame, 'b');
    const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x = shape.start + 4 - scrollLeft;
    pointer(scroller, 'pointerdown', x, middle);
    pointer(scroller, 'pointermove', x + 24 * pixelsPerHour('day'), middle);
    pointer(scroller, 'pointerup', x + 24 * pixelsPerHour('day'), middle);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'b')).toMatchObject({
      startNoEarlierThan: at(2026, 9, 29),
    });
  });

  it('stretches a bar to change its duration, and links a task dragged from its handle', async () => {
    const { app, scroller, frame, scrollLeft } = await renderSized();
    const shape = shapeIn(app, frame, 'a');
    const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    pointer(scroller, 'pointerdown', shape.end - 1 - scrollLeft, middle);
    pointer(scroller, 'pointermove', shape.end + 24 * pixelsPerHour('day') - scrollLeft, middle);
    pointer(scroller, 'pointerup', shape.end + 24 * pixelsPerHour('day') - scrollLeft, middle);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      segments: [{ durationHours: 14 }],
    });
    const stretched = shapeIn(app, frame, 'a');
    const target = shapeIn(app, frame, 'b');
    const handleX = stretched.end + LINK_HANDLE_GAP - scrollLeft;
    const targetMiddle = target.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    pointer(scroller, 'pointerdown', handleX, middle);
    pointer(scroller, 'pointermove', target.start + 5 - scrollLeft, targetMiddle);
    pointer(scroller, 'pointerup', target.start + 5 - scrollLeft, targetMiddle);
    await settle();
    expect(app.project?.dependencies).toMatchObject([{ predecessorId: 'a', successorId: 'b' }]);
  });

  it('refuses to move or stretch a bar while the dates shown are older than the latest change, then accepts once they are updated', async () => {
    const { app, scroller, frame, scrollLeft, scheduler } = await renderSized();
    const shape = shapeIn(app, frame, 'b');
    const before = app.project?.tasks.find((task) => task.id === 'b');
    scheduler.automatic = false;
    expect(app.rename('Renamed')).toBe(true);
    await settle();
    expect(app.currentSchedule).toEqual({ ok: false, error: 'SCHEDULE_PENDING' });
    expect(app.schedule).not.toBeNull();
    const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x = shape.start + 4 - scrollLeft;
    /** Drags the pointer on the timeline from one place to another on the same row. */
    const dragTo = (from: number, to: number) => {
      pointer(scroller, 'pointerdown', from, middle);
      pointer(scroller, 'pointermove', to, middle);
      pointer(scroller, 'pointerup', to, middle);
    };
    dragTo(x, x + 24 * pixelsPerHour('day'));
    dragTo(shape.end - 1 - scrollLeft, shape.end + 24 * pixelsPerHour('day') - scrollLeft);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'b')).toEqual(before);
    expect(app.notices.map((notice) => notice.text)).toEqual([english.editErrors.SCHEDULE_PENDING]);
    const latest = app.project;
    if (latest === null) {
      throw new Error('The project closed.');
    }
    scheduler.listener().scheduled(scheduleProject(latest), latest);
    expect(app.currentSchedule).toEqual({ ok: true, value: app.schedule });
    dragTo(x, x + 24 * pixelsPerHour('day'));
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'b')).toMatchObject({
      startNoEarlierThan: at(2026, 9, 29),
    });
  });

  it('opens the details of a task double-clicked on the timeline', async () => {
    const { app, scroller } = await renderSized();
    scroller.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 5, clientY: ROW_HEIGHT + 3, bubbles: true }),
    );
    update();
    expect(app.detailsTaskId).toBe('b');
  });

  it('scrolls the least needed to show the row selected with the keyboard', async () => {
    const { app, root, scroller } = await renderSized();
    resize(scroller, 800, ROW_HEIGHT);
    const grid = single(root, '[role="grid"]');
    app.select('a');
    update();
    press(grid, 'ArrowDown');
    expect(scroller.scrollTop).toBe(ROW_HEIGHT);
    press(grid, 'ArrowDown');
    expect(scroller.scrollTop).toBe(ROW_HEIGHT);
    press(grid, 'ArrowUp');
    expect(scroller.scrollTop).toBe(0);
    resize(scroller, 800, SCROLLER_HEIGHT);
    press(grid, 'ArrowDown');
    expect(app.selectedTaskId).not.toBe('a');
    expect(scroller.scrollTop).toBe(0);
  });

  it('draws the plan before its schedule is known', async () => {
    const fake = fakeAppContext();
    fake.scheduler.automatic = false;
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf(PLAN);
    await app.open();
    const root = render(App, { app });
    const scroller = single(root, '.scroller');
    resize(scroller, 800, 400);
    expect(app.schedule).toBeNull();
    const frame = timelineFrame(PLAN.startDate, null, localHourOf(TODAY), pixelsPerHour('day'), []);
    expect(scroller.scrollLeft).toBe(xOf(frame, PLAN.startDate - 48));
  });

  it('scrolls both panes together, from the wheel over the table or the scroll of the timeline', async () => {
    const { root, scroller } = await renderSized();
    resize(scroller, 800, ROW_HEIGHT);
    const grid = single(root, '[role="grid"]');
    grid.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
    update();
    expect(scroller.scrollTop).toBe(10);
    grid.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true }));
    update();
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 20;
    scroller.dispatchEvent(new Event('scroll'));
    update();
    expect(single(root, '.rows').style.transform).toBe('translateY(-20px)');
  });

  it('moves the today line as time passes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(TODAY);
    const { scroller } = await renderSized();
    /** Returns where the line of today is drawn on the timeline. */
    const todayLineX = (): number => {
      const lines = drawFrames().filter(
        (call) =>
          call.name === 'fillRect' &&
          call.fillStyle === SAND_GRAPHITE.error &&
          call.args[3] === SCROLLER_HEIGHT,
      );
      expect(lines).toHaveLength(1);
      return Number(lines[0]?.args[0]);
    };
    const before = todayLineX();
    vi.setSystemTime(new Date(2026, 8, 28, 15));
    vi.advanceTimersByTime(60_000);
    update();
    pointer(scroller, 'pointermove', 1, 1);
    expect(todayLineX() - before).toBe(3 * pixelsPerHour('day'));
  });

  it('keeps the same moment in view when the zoom changes', async () => {
    const { app, scroller, scrollLeft } = await renderSized();
    app.zoom = 'week';
    update();
    expect(scroller.scrollLeft).toBe(zoomedScrollLeft(scrollLeft, 800, 'day', 'week'));
  });
});
