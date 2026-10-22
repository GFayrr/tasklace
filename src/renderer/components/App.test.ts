import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TaskId } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { project, workTask, testId } from '../../core/testing/project-builder';
import { encodeMessage, type CollaborationMessage } from '../../core/collaboration/messages';
import { requireParticipantId, type Participant } from '../../core/collaboration/participants';
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
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import App from './App.svelte';
import { button, click, press, render, single, update } from './testing/render';
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
    app.select(testId('a'));
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
    app.openDetails(testId('a'));
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

describe('the window that tells where changes made in read only are kept', () => {
  /** Renders the interface after this person, in read only, changed the joined plan away from the host and came back. */
  async function keptApp() {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    const { collaboration } = fake.control;
    collaboration.settingsResult = {
      ok: true,
      value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true },
    };
    collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
    await app.collaboration.loadSettings();
    await app.join({ address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ' });
    const me = app.collaboration.me ?? requireParticipantId('lea');
    const host: Participant = {
      id: requireParticipantId('camille'),
      name: 'Camille',
      color: 0,
      canEdit: true,
      isHost: true,
      rank: 0,
      selectedTaskId: null,
      endpoint: null,
      tokenDigest: null,
    };
    const lea: Participant = {
      ...host,
      id: me,
      name: 'Léa',
      canEdit: false,
      isHost: false,
      rank: 1,
    };
    /** Gives the page a message of the host. */
    const fromHost = (message: CollaborationMessage): void => {
      collaboration.listener?.({ kind: 'hostMessage', message: encodeMessage(message) });
    };
    collaboration.listener?.({ kind: 'connected' });
    fromHost({ kind: 'participants', you: me, participants: [host, lea] });
    fromHost({ kind: 'update', update: Uint8Array.of(0, 0) });
    await settle();
    await settle();
    collaboration.listener?.({ kind: 'reconnecting' });
    app.rename('Mine');
    collaboration.listener?.({ kind: 'connected' });
    fromHost({ kind: 'stateVector', vector: Uint8Array.of(0) });
    await settle();
    fromHost({ kind: 'update', update: Uint8Array.of(0, 0) });
    await settle();
    await settle();
    const root = render(App, { app });
    return { app, root, ...fake };
  }

  /** Returns the open window that tells where the changes are kept. */
  function keptWindow(root: ParentNode): HTMLDialogElement {
    const dialog = single(root, 'dialog[aria-labelledby="kept-changes-title"]');
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error('Not a dialog');
    }
    return dialog;
  }

  it('names the plan and its copy, with “OK” as the main button, and closes on “OK”', async () => {
    const { app, root } = await keptApp();
    const dialog = keptWindow(root);
    expect([
      dialog.open,
      single(dialog, 'h3').textContent,
      single(dialog, 'p').textContent,
      [...dialog.querySelectorAll('button')].map((each) => [
        each.textContent.trim(),
        each.classList.contains('primary'),
      ]),
    ]).toEqual([
      true,
      english.collaboration.keptTitle,
      'You changed the plan while you were away, but you are in read only in “Mine”, so your changes cannot be shared. They are kept in a separate plan, “Mine (my changes)”, on this computer. You now see the shared plan again.',
      [
        ['OK', true],
        ['Open my changes', false],
      ],
    ]);
    click(button(dialog, 'OK'));
    expect([app.keptChanges, dialog.open]).toEqual([null, false]);
  });

  it('opens the changes kept, leaving the shared plan, and ignores the shortcuts while it is open', async () => {
    const { app, root, control } = await keptApp();
    press(window, 'o', { ctrlKey: true });
    control.collaboration.openKeptResult = openedProjectOf({ ...PLAN, name: 'Mine (my changes)' });
    click(button(keptWindow(root), 'Open my changes'));
    await settle();
    app.closePrompt?.answer('discard');
    await settle();
    await settle();
    expect([
      control.calls.filter((call) => call === 'openProject'),
      app.project?.name,
      app.keptChanges,
    ]).toEqual([[], 'Mine (my changes)', null]);
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
      at(2026, 9, 28, 12),
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
    id: TaskId,
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
    const shape = shapeIn(app, frame, testId('b'));
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
    const shape = shapeIn(app, frame, testId('a'));
    const middle = shape.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    pointer(scroller, 'pointerdown', shape.end - 1 - scrollLeft, middle);
    pointer(scroller, 'pointermove', shape.end + 24 * pixelsPerHour('day') - scrollLeft, middle);
    pointer(scroller, 'pointerup', shape.end + 24 * pixelsPerHour('day') - scrollLeft, middle);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      segments: [{ durationHours: 14 }],
    });
    const stretched = shapeIn(app, frame, testId('a'));
    const target = shapeIn(app, frame, testId('b'));
    const handleX = stretched.end + LINK_HANDLE_GAP - scrollLeft;
    const targetMiddle = target.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    pointer(scroller, 'pointerdown', handleX, middle);
    pointer(scroller, 'pointermove', target.start + 5 - scrollLeft, targetMiddle);
    pointer(scroller, 'pointerup', target.start + 5 - scrollLeft, targetMiddle);
    await settle();
    expect(app.project?.dependencies).toMatchObject([
      { predecessorId: testId('a'), successorId: testId('b') },
    ]);
  });

  it('refuses to move or stretch a bar while the dates shown are older than the latest change, then accepts once they are updated', async () => {
    const { app, scroller, frame, scrollLeft, scheduler } = await renderSized();
    const shape = shapeIn(app, frame, testId('b'));
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
    app.select(testId('a'));
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
    const frame = timelineFrame(
      PLAN.startDate,
      null,
      at(2026, 9, 28, 12),
      pixelsPerHour('day'),
      [],
    );
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

  it('moves the today line as time passes, to the quarter hour', async () => {
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
    vi.setSystemTime(new Date(2026, 8, 28, 15, 42));
    vi.advanceTimersByTime(60_000);
    update();
    pointer(scroller, 'pointermove', 1, 1);
    expect(todayLineX() - before).toBeCloseTo(3.5 * pixelsPerHour('day'), 9);
  });

  it('draws no today line while the clock is outside the years handled', async () => {
    vi.setSystemTime(new Date(2240, 0, 1, 9));
    const { scroller } = await renderSized();
    pointer(scroller, 'pointermove', 1, 1);
    const lines = drawFrames().filter(
      (call) =>
        call.name === 'fillRect' &&
        call.fillStyle === SAND_GRAPHITE.error &&
        call.args[3] === SCROLLER_HEIGHT,
    );
    expect(lines).toEqual([]);
  });

  it('keeps the same moment in view when the zoom changes', async () => {
    const { app, scroller, scrollLeft } = await renderSized();
    app.setZoom('week');
    update();
    expect(scroller.scrollLeft).toBe(zoomedScrollLeft(scrollLeft, 800, 'day', 'week'));
  });
});
