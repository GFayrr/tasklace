import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { link, milestone, project, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import { createMomentFormatter } from '../i18n/format';
import english from '../locales/en.json';
import { setDuration } from '../plan/task-commands';
import { pixelsPerHour } from '../plan/time-scale';
import { baselineMarks, ROW_HEIGHT, timelineFrame, xOf } from '../plan/timeline-geometry';
import { paleColor } from '../plan/tag-styles';
import { localHourOf } from '../project/new-project';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import App from './App.svelte';
import { pixels } from './css-length';
import { button, click, press, render, single, update } from './testing/render';
import { drawFrames, resize } from './testing/timeline-environment';

const TEXT = english.settings;
const TABLE = english.table;
const NOW = new Date(2026, 8, 28, 8, 20);
const LATER = new Date(2026, 8, 29, 11, 50);
const PLAN: Project = project(
  [
    workTask('a', { name: 'Review', sortKey: 'a' }),
    workTask('b', { name: 'Write', sortKey: 'b' }),
    milestone('m', { name: 'Defense', sortKey: 'c' }),
  ],
  [link('a', 'b'), link('b', 'm')],
  {
    name: 'Thesis',
    startDate: at(2026, 9, 28, 9),
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
      baselineEnabled: true,
      alwaysShowPatterns: false,
    },
  },
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the sized application over a plan and opens the Advanced options tab of its settings. */
async function renderAdvanced(plan: Project = PLAN) {
  const fake = fakeAppContext();
  const app = new AppState({ ...fake.context, now: () => new Date() });
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  const root = render(App, { app });
  resize(single(root, 'main.workspace'), 1_200, 600);
  resize(single(root, '.scroller'), 800, 340);
  app.openSettings();
  update();
  const dialog = single(root, 'dialog.settings') as HTMLDialogElement;
  click(button(dialog, TEXT.advanced));
  update();
  return { app, root, dialog, ...fake };
}

/** Returns the confirmation dialog of the baseline. */
function question(dialog: ParentNode): HTMLDialogElement {
  return single(dialog, 'dialog.confirm') as HTMLDialogElement;
}

describe('the baseline in the Advanced options tab', () => {
  it('sets the first baseline at once, then shows when it was set', async () => {
    const { app, dialog } = await renderAdvanced();
    const strip = single(dialog, '.baseline');
    expect(single(strip, '.when').textContent).toBe(TEXT.baselineNone);
    click(button(strip, TEXT.setBaseline));
    await settle();
    update();
    expect(question(dialog).open).toBe(false);
    const takenAt = app.project?.baseline?.takenAt ?? Number.NaN;
    expect(takenAt).toBe(at(2026, 9, 28, 8) + 0.25);
    expect(single(dialog, '.baseline .when').textContent).toBe(
      TEXT.baselineSetOn.replace('{date}', createMomentFormatter(app.locale)(takenAt)),
    );
  });

  it('asks before replacing the baseline, keeping it on Cancel', async () => {
    const { app, dialog } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    const first = app.project?.baseline;
    vi.setSystemTime(LATER);
    click(button(dialog, TEXT.setBaselineAgain));
    update();
    const asked = question(dialog);
    expect(asked.open).toBe(true);
    expect(single(asked, 'h3').textContent).toBe(TEXT.replaceBaselineTitle);
    expect(single(asked, 'p').textContent.trim()).toBe(
      TEXT.replaceBaselineBody.replace(
        '{date}',
        createMomentFormatter(app.locale)(first?.takenAt ?? Number.NaN),
      ),
    );
    click(button(asked, TEXT.cancel));
    update();
    expect([asked.open, app.project?.baseline]).toEqual([false, first]);
    click(button(dialog, TEXT.setBaselineAgain));
    update();
    click(button(asked, TEXT.replaceBaselineConfirm));
    await settle();
    update();
    expect(asked.open).toBe(false);
    expect(app.project?.baseline?.takenAt).toBe(at(2026, 9, 29, 11) + 0.75);
  });

  it('asks before clearing the baseline, keeping undo away from the question', async () => {
    const { app, dialog } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    click(button(dialog, TEXT.clearBaseline));
    update();
    const asked = question(dialog);
    expect(single(asked, 'h3').textContent).toBe(TEXT.clearBaselineTitle);
    expect(single(asked, '.danger').textContent).toBe(TEXT.clearBaselineConfirm);
    const before = app.project;
    expect(press(asked, 'z', { ctrlKey: true })).toBe(true);
    expect(press(asked, 'Y', { metaKey: true })).toBe(true);
    await settle();
    expect(app.project).toBe(before);
    click(button(asked, TEXT.clearBaselineConfirm));
    await settle();
    update();
    expect(app.project?.baseline).toBeNull();
    expect(single(dialog, '.baseline .when').textContent).toBe(TEXT.baselineNone);
  });

  it('closes the question when its dialog is closed, and hides the strip once the baseline is turned off', async () => {
    const { app, dialog } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    click(button(dialog, TEXT.clearBaseline));
    update();
    const asked = question(dialog);
    asked.close();
    update();
    expect(asked.open).toBe(false);
    expect(app.project?.baseline).not.toBeNull();
    const toggle = dialog.querySelector('[aria-labelledby="advanced-baseline"]');
    if (!(toggle instanceof HTMLElement)) {
      throw new Error('No switch');
    }
    click(toggle);
    await settle();
    update();
    expect(dialog.querySelectorAll('.baseline')).toHaveLength(0);
  });

  it('explains why the baseline cannot be set while the dates are being computed', async () => {
    const { app, dialog, scheduler } = await renderAdvanced();
    scheduler.automatic = false;
    expect(app.edit((context) => setDuration(context, 'a', '14'))).toBe(true);
    click(button(dialog, TEXT.setBaseline));
    update();
    expect(single(dialog, '.advanced [role="alert"]').textContent).toBe(
      english.editErrors.SCHEDULE_PENDING,
    );
  });
});

describe('the questions and messages of the baseline', () => {
  it('ignores the close event of a question it opened again meanwhile', async () => {
    const { dialog } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    click(button(dialog, TEXT.clearBaseline));
    update();
    const asked = question(dialog);
    asked.close();
    click(button(dialog, TEXT.setBaselineAgain));
    update();
    asked.dispatchEvent(new Event('close'));
    update();
    expect([asked.open, single(asked, 'h3').textContent]).toEqual([
      true,
      TEXT.replaceBaselineTitle,
    ]);
  });

  it('closes a question whose baseline disappears or is hidden while it is asked', async () => {
    const { app, dialog } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    click(button(dialog, TEXT.setBaselineAgain));
    update();
    expect(question(dialog).open).toBe(true);
    expect(app.clearBaseline()).toBeNull();
    update();
    expect(question(dialog).open).toBe(false);
  });

  it('shows below the strip how many tasks could not be frozen', async () => {
    const { app, dialog, scheduler } = await renderAdvanced();
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const schedule = app.schedule;
    if (schedule === null) {
      throw new Error('No schedule');
    }
    const placements = new Map([...schedule.placements].filter(([id]) => id !== 'm'));
    scheduler.listener().scheduled({ ok: true, value: { ...schedule, placements } }, opened);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      click(button(dialog, TEXT.setBaseline));
      update();
    } finally {
      logged.mockRestore();
    }
    expect(single(dialog, '.advanced [role="status"]').textContent).toBe(
      english.notices.baselineSkipped.one.replace('{count}', '1'),
    );
  });

  it('explains a refusal after the user confirmed a replacement', async () => {
    const { app, dialog, scheduler } = await renderAdvanced();
    click(button(dialog, TEXT.setBaseline));
    await settle();
    update();
    scheduler.automatic = false;
    expect(app.edit((context) => setDuration(context, 'a', '14'))).toBe(true);
    click(button(dialog, TEXT.setBaselineAgain));
    update();
    click(button(question(dialog), TEXT.replaceBaselineConfirm));
    update();
    expect(question(dialog).open).toBe(false);
    expect(single(dialog, '.advanced [role="alert"]').textContent).toBe(
      english.editErrors.SCHEDULE_PENDING,
    );
  });
});

describe('the baseline in the table and on the timeline', () => {
  /** Renders the plan with its baseline set, then lengthens Write by a working day of seven hours. */
  async function renderMoved() {
    const rendered = await renderAdvanced();
    click(button(rendered.dialog, TEXT.setBaseline));
    await settle();
    expect(rendered.app.edit((context) => setDuration(context, 'b', '14'))).toBe(true);
    await settle();
    update();
    return rendered;
  }

  it('adds a Variance column after End, late in the warning color and a dash for a new task', async () => {
    const { app, root } = await renderMoved();
    const header = [...root.querySelectorAll<HTMLElement>('[role="columnheader"]')];
    expect(header.map((cell) => cell.textContent).slice(4, 6)).toEqual([TABLE.end, TABLE.variance]);
    expect(header[5]?.title).toBe(TABLE.varianceHint);
    expect(single(root, '.table').classList.contains('with-variance')).toBe(true);
    const cells = [...root.querySelectorAll<HTMLElement>('[role="gridcell"].variance')];
    expect(
      cells.map((cell) => [cell.textContent.trim(), cell.className.includes('behind'), cell.title]),
    ).toEqual([
      ['0 d', false, ''],
      ['+1 d', true, ''],
      ['+1 d', true, ''],
    ]);
    app.addTask();
    await settle();
    update();
    const added = [...root.querySelectorAll<HTMLElement>('[role="gridcell"].variance')].at(-1);
    expect([added?.textContent.trim(), added?.title]).toEqual(['—', TABLE.varianceNotInBaseline]);
  });

  it('draws a ghost under each bar and a hollow diamond for the milestone, and widens the timeline to the baseline', async () => {
    const { app } = await renderMoved();
    const baseline = app.shownBaseline;
    const frame = timelineFrame(
      PLAN.startDate,
      app.schedule,
      localHourOf(NOW),
      pixelsPerHour(app.zoom),
      baselineMarks(app.project?.baseline ?? null, (id) => app.outline.wbsById.has(id)),
    );
    const pale = paleColor(SAND_GRAPHITE.textSecondary);
    const ghosts = drawFrames()
      .filter((call) => call.name === 'fillRect' && call.fillStyle === pale && call.args[3] === 3)
      .map((call) => [call.args[0], call.args[1]]);
    const rowOf = (id: string) => (app.outline.rowIndexById.get(id) ?? -1) * ROW_HEIGHT;
    expect(ghosts).toEqual([
      [xOf(frame, baseline?.get('a')?.start ?? Number.NaN), rowOf('a') + 2],
      [xOf(frame, baseline?.get('b')?.start ?? Number.NaN), rowOf('b') + 2],
    ]);
    const key = single(document.body, '.status-bar .baseline-key');
    expect([key.textContent.trim(), key.title]).toEqual([
      english.status.baseline,
      english.status.baselineHint,
    ]);
  });

  it('widens the timeline to a frozen end far after the plan, only while the baseline is shown, ignoring deleted tasks', async () => {
    const far = at(2027, 3, 1, 17);
    const baseline = {
      takenAt: at(2026, 9, 27, 9),
      entries: [
        { taskId: 'b', start: at(2027, 2, 1, 9), end: far, durationHours: 7 },
        { taskId: 'gone', start: at(2028, 6, 1, 9), end: at(2028, 6, 1, 17), durationHours: 7 },
      ],
    };
    const shown = await renderAdvanced({ ...PLAN, baseline });
    const spacerOf = (root: HTMLElement) => single(root, '.scroller .spacer').style.width;
    const frameWith = (marks: readonly number[]) =>
      timelineFrame(
        PLAN.startDate,
        shown.app.schedule,
        localHourOf(NOW),
        pixelsPerHour('day'),
        marks,
      );
    const widened = frameWith([at(2027, 2, 1, 9), far]);
    expect(widened.end).toBe(at(2027, 3, 31));
    expect(spacerOf(shown.root)).toBe(pixels(xOf(widened, widened.end)));
    expect(frameWith([]).end).toBeLessThan(widened.end);
    const hidden = await renderAdvanced({
      ...PLAN,
      options: { ...PLAN.options, baselineEnabled: false },
      baseline,
    });
    const plain = frameWith([]);
    expect(spacerOf(hidden.root)).toBe(pixels(xOf(plain, plain.end)));
  });

  it('shows neither the column, the ghosts nor the key while the baseline is turned off or not set', async () => {
    const plan = { ...PLAN, options: { ...PLAN.options, baselineEnabled: false } };
    const pale = paleColor(SAND_GRAPHITE.textSecondary);
    for (const shown of [
      {
        ...plan,
        baseline: {
          takenAt: at(2026, 9, 27, 9),
          entries: [
            { taskId: 'a', start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 17), durationHours: 7 },
          ],
        },
      },
      PLAN,
    ]) {
      const { root } = await renderAdvanced(shown);
      expect(root.querySelectorAll('.variance')).toHaveLength(0);
      expect(root.querySelectorAll('.baseline-key')).toHaveLength(0);
      expect(drawFrames().filter((call) => call.fillStyle === pale && call.args[3] === 3)).toEqual(
        [],
      );
      root.remove();
    }
  });

  it('keeps the columns in order when the variance and the floats show together', async () => {
    const { root } = await renderAdvanced({
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
      baseline: { takenAt: at(2026, 9, 27, 9), entries: [] },
    });
    expect(
      [...root.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent),
    ).toEqual([
      TABLE.wbs,
      TABLE.name,
      TABLE.duration,
      TABLE.start,
      TABLE.end,
      TABLE.variance,
      TABLE.totalFloat,
      TABLE.freeFloat,
      TABLE.progress,
      TABLE.predecessors,
      TABLE.tag,
    ]);
    const row = [...root.querySelectorAll('.rows [role="row"]')][0];
    const classes = [...(row?.querySelectorAll('[role="gridcell"]') ?? [])].map((cell) =>
      ['end', 'variance', 'float'].find((name) => cell.classList.contains(name)),
    );
    expect(classes.filter((name) => name !== undefined)).toEqual([
      'end',
      'variance',
      'float',
      'float',
    ]);
    const table = single(root, '.table');
    expect([
      table.classList.contains('with-floats'),
      table.classList.contains('with-variance'),
    ]).toEqual([true, true]);
  });
});
