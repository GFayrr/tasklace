import { describe, expect, it } from 'vitest';
import { MIN_PROJECT_YEAR } from '../../core/limits';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { link, project, workTask } from '../../core/testing/project-builder';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { click, render, single, update } from './testing/render';

const TEXT = english.settings;
const PLAN: Project = project(
  [
    workTask('a', { name: 'Review', sortKey: 'a' }),
    workTask('b', { name: 'Write', sortKey: 'b' }),
    workTask('c', {
      name: 'Figures',
      sortKey: 'c',
      segments: [{ durationHours: 2, gapDaysBefore: 0, startNoEarlierThan: null }],
    }),
  ],
  [link('a', 'b')],
  { name: 'Thesis', startDate: at(2026, 9, 28, 9) },
);

/** Renders the application over a plan and opens the Advanced options tab of its settings. */
async function renderAdvanced(plan: Project = PLAN) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  const root = render(App, { app });
  app.openSettings();
  update();
  const dialog = single(root, 'dialog.settings') as HTMLDialogElement;
  const tab = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === TEXT.advanced,
  );
  click(tab ?? dialog);
  update();
  return { app, root, dialog, ...fake };
}

/** Returns the switch of a feature by its heading. */
function switchOf(dialog: ParentNode, label: string): HTMLButtonElement {
  const heading = [...dialog.querySelectorAll('h3')].find((entry) => entry.textContent === label);
  const found = dialog.querySelector(`[aria-labelledby="${heading?.id ?? ''}"]`);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`No switch for ${label}`);
  }
  return found;
}

/** Returns the texts of the column headers of the task table. */
function headers(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent);
}

describe('the Advanced options tab', () => {
  it('lists every feature with its sentence, the coming ones turned off and grayed out', async () => {
    const { dialog } = await renderAdvanced();
    const choices = [...dialog.querySelectorAll('.choice')];
    expect(
      choices.map((choice) => [
        choice.querySelector('h3')?.textContent,
        choice.querySelector('p')?.textContent,
        choice.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
        choice.querySelector('[role="switch"]')?.getAttribute('aria-disabled'),
      ]),
    ).toEqual([
      [TEXT.criticalPath, TEXT.criticalPathHint, 'false', null],
      [TEXT.dateConstraints, TEXT.dateConstraintsHint, 'false', null],
      [TEXT.baseline, TEXT.baselineHint, 'false', 'true'],
      [TEXT.alwaysShowPatterns, TEXT.alwaysShowPatternsHint, 'false', null],
    ]);
    expect([...dialog.querySelectorAll('.soon')].map((soon) => soon.textContent)).toEqual([
      TEXT.soon,
    ]);
  });

  it('turns the critical path on and off, showing the floats in the table and the key in the legend', async () => {
    const { app, root, dialog } = await renderAdvanced();
    expect(headers(root)).not.toContain(english.table.totalFloat);
    expect(root.querySelectorAll('.critical-key')).toHaveLength(0);
    const critical = switchOf(dialog, TEXT.criticalPath);
    click(critical);
    await settle();
    update();
    expect(app.project?.options.criticalPathEnabled).toBe(true);
    expect(critical.getAttribute('aria-checked')).toBe('true');
    expect(headers(root).slice(4, 7)).toEqual([
      english.table.end,
      english.table.totalFloat,
      english.table.freeFloat,
    ]);
    expect(
      [...root.querySelectorAll<HTMLElement>('[role="columnheader"].float')].map(
        (cell) => cell.title,
      ),
    ).toEqual([english.table.totalFloatHint, english.table.freeFloatHint]);
    expect(single(root, '.table').classList.contains('with-floats')).toBe(true);
    expect(single(root, '.critical-key').textContent.trim()).toBe(english.status.critical);
    const figures = [...root.querySelectorAll('[role="row"]')].find((row) =>
      row.textContent.includes('Figures'),
    );
    const floatTexts = [...(figures?.querySelectorAll('.float') ?? [])].map((cell) =>
      cell.textContent.trim(),
    );
    expect(floatTexts).toEqual(['12 h', '12 h']);
    const review = [...root.querySelectorAll('[role="row"]')].find((row) =>
      row.textContent.includes('Review'),
    );
    expect(review?.querySelector('.name')?.classList.contains('critical')).toBe(true);
    expect(figures?.querySelector('.name')?.classList.contains('critical')).toBe(false);
    click(critical);
    await settle();
    update();
    expect(app.project?.options.criticalPathEnabled).toBe(false);
    expect(headers(root)).not.toContain(english.table.totalFloat);
  });

  it('turns patterns and date constraints on, and does nothing for a coming feature', async () => {
    const { app, dialog } = await renderAdvanced();
    const before = app.project;
    click(switchOf(dialog, TEXT.baseline));
    update();
    expect(app.project).toBe(before);
    click(switchOf(dialog, TEXT.alwaysShowPatterns));
    update();
    expect(app.project?.options.alwaysShowPatterns).toBe(true);
    const constraints = switchOf(dialog, TEXT.dateConstraints);
    click(constraints);
    update();
    expect([
      app.project?.options.dateConstraintsEnabled,
      constraints.getAttribute('aria-checked'),
    ]).toEqual([true, 'true']);
  });

  it('applies the date constraints once turned on, a late task showing a negative float', async () => {
    const late: Project = {
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
      tasks: PLAN.tasks.map((task) =>
        task.id === 'c' && task.kind === 'task'
          ? { ...task, mustFinishOn: at(2026, 9, 28, 10) }
          : task,
      ),
    };
    const { root, dialog } = await renderAdvanced(late);
    const totalOf = () => {
      const figures = [...root.querySelectorAll('[role="row"]')].find((row) =>
        row.textContent.includes('Figures'),
      );
      return figures?.querySelector('.float')?.textContent.trim();
    };
    expect(totalOf()).toBe('12 h');
    click(switchOf(dialog, TEXT.dateConstraints));
    await settle();
    update();
    expect(totalOf()).toBe('\u22121 h');
  });

  it('explains a refused change, as while a file action runs', async () => {
    const { app, dialog, context } = await renderAdvanced();
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () =>
        new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        }),
    });
    const opening = app.open();
    await settle();
    click(switchOf(dialog, TEXT.criticalPath));
    update();
    expect(single(dialog, '[role="alert"]').textContent).toBe(english.fileErrors.BUSY);
    expect(app.project?.options.criticalPathEnabled).toBe(false);
    finish({ ok: false, error: { code: 'CANCELLED' } });
    await opening;
  });

  it('shows an unknown float as a question mark explained by the first supported year, the task being critical', async () => {
    const start = 490_896;
    const block = (durationHours: number, gapDaysBefore: number) => ({
      durationHours,
      gapDaysBefore,
      startNoEarlierThan: null,
    });
    const sparse: Project = {
      ...project(
        [
          workTask('a', { name: 'Interviews', segments: [block(0.25, 0)], sortKey: 'a' }),
          workTask('b', {
            name: 'Report',
            sortKey: 'b',
            segments: [block(19.5, 0), block(27.5, 8), block(21.5, 8)],
            mustFinishOn: start,
          }),
        ],
        [link('a', 'b', 'finishToStart', 13.75)],
        {
          startDate: start,
          options: {
            criticalPathEnabled: true,
            dateConstraintsEnabled: true,
            alwaysShowPatterns: false,
          },
        },
      ),
      calendar: {
        workingWeekdays: [5],
        workingTimeRanges: [{ startHour: 4.25, endHour: 4.5 }],
        nonWorkingPeriods: [],
      },
    };
    const { root } = await renderAdvanced(sparse);
    const interviews = [...root.querySelectorAll('[role="row"]')].find((row) =>
      row.textContent.includes('Interviews'),
    );
    const cells = [...(interviews?.querySelectorAll<HTMLElement>('.float') ?? [])];
    expect(cells.map((cell) => [cell.textContent.trim(), cell.title])).toEqual([
      ['?', english.table.unknownFloat.replace('{firstYear}', String(MIN_PROJECT_YEAR))],
      ['?', ''],
    ]);
    expect(interviews?.querySelector('.name')?.classList.contains('critical')).toBe(true);
  });
});
