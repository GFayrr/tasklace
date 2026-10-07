import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import {
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import { deleteTasks } from '../plan/task-commands';
import TaskDetails from './TaskDetails.svelte';
import { button, click, dialogIn, render, single, update } from './testing/render';

const TEXT = english.details;
const DESIGN = { id: 'design', name: 'Design', color: '#3366AA', representsPersonOrTeam: false };
const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a', name: 'Study' }),
    workTask('a', { parentId: 's', name: 'Read' }),
    splitTask(
      'b',
      [
        [7, 0],
        [7, 1],
      ],
      { sortKey: 'b', name: 'Write', tagId: 'design' },
    ),
    milestone('m', { sortKey: 'c', name: 'Hand in' }),
  ],
  [],
  { name: 'Thesis', tags: [DESIGN] },
);

/** Returns the open project, failing the test when none is open. */
function currentProject(app: AppState): Project {
  if (app.project === null) {
    throw new Error('No project');
  }
  return app.project;
}

/** Renders the details panel over the sample plan. */
async function renderDetails() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  const root = render(TaskDetails, { app, project: currentProject(app) });
  return { app, root };
}

/** Opens the panel of a task and applies the updates. */
function openFor(app: AppState, id: string): void {
  app.openDetails(id);
  update();
}

/** Finds the field of the panel with a label, failing the test when there is none. */
function field(root: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...root.querySelectorAll('label')].find(
    (candidate) => candidate.querySelector('span')?.textContent === label,
  );
  const control = found?.querySelector('input, select');
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`No field ${label}`);
  }
  return control;
}

/** Types a value into a field, as the user would. */
function type(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  update();
}

/** Submits the panel. */
function submit(root: HTMLElement): void {
  single(root, 'form').dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  );
  update();
}

describe('TaskDetails', () => {
  it('opens on a work task with its fields filled, and closes with Cancel', async () => {
    const { app, root } = await renderDetails();
    const dialog = dialogIn(root);
    expect(dialog.open).toBe(false);
    openFor(app, 'a');
    expect(dialog.open).toBe(true);
    expect(field(root, TEXT.name).value).toBe('Read');
    expect(field(root, TEXT.progress).value).toBe('0');
    expect(field(root, TEXT.tag).value).toBe('');
    expect(field(root, TEXT.blockDuration.replace('{number}', '1')).value).toBe('7 h');
    expect(root.querySelector('.waits')).toBeNull();
    click(button(root, TEXT.cancel));
    expect(app.detailsTaskId).toBeNull();
    expect(dialog.open).toBe(false);
  });

  it('applies the changes of the panel to its task and closes', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'a');
    type(field(root, TEXT.name), 'Read again');
    type(field(root, TEXT.progress), '40');
    submit(root);
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      name: 'Read again',
      progressPercent: 40,
    });
    expect(app.detailsTaskId).toBeNull();
  });

  it('keeps the panel open with the reason of a refusal', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'a');
    type(field(root, TEXT.progress), 'half');
    submit(root);
    expect(single(root, '[role="alert"]').textContent).toBe(english.editErrors.INVALID_PROGRESS);
    expect(dialogIn(root).open).toBe(true);
  });

  it('offers the tags by name in the order of the language, after the choice of no tag', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf({
      ...PLAN,
      tags: [{ ...DESIGN, id: 'z', name: 'Zeta' }, DESIGN, { ...DESIGN, id: 'b', name: 'beta' }],
    });
    await app.open();
    const root = render(TaskDetails, { app, project: currentProject(app) });
    openFor(app, 'a');
    const options = [...field(root, TEXT.tag).querySelectorAll('option')];
    expect(options.map((option) => option.textContent.trim())).toEqual([
      TEXT.noTag,
      'beta',
      'Design',
      'Zeta',
    ]);
  });

  it('asks for a daily start only for a task working part of the day', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'a');
    expect(() => field(root, TEXT.dailyStart)).toThrow();
    type(field(root, TEXT.hoursPerDay), '4');
    expect(field(root, TEXT.dailyStart).value).toBe('');
    type(field(root, TEXT.hoursPerDay), '7');
    expect(() => field(root, TEXT.dailyStart)).toThrow();
    type(field(root, TEXT.hoursPerDay), '6.75');
    expect(field(root, TEXT.dailyStart).value).toBe('');
    type(field(root, TEXT.hoursPerDay), 'not hours');
    expect(() => field(root, TEXT.dailyStart)).toThrow();
  });

  it('adds and removes blocks, with their gap, start and waits once there are several', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'b');
    expect(field(root, TEXT.tag).value).toBe('design');
    expect(field(root, TEXT.blockGap.replace('{previous}', '1')).value).toBe('1');
    expect(field(root, TEXT.blockWaitsFor.replace('{number}', '2')).value).toBe(
      app.blockWaitText('b', 1),
    );
    click(button(root, TEXT.addBlock));
    expect(field(root, TEXT.blockDuration.replace('{number}', '3')).value).toBe('7 h');
    click(button(root, TEXT.removeBlock.replace('{number}', '1')));
    click(button(root, TEXT.removeBlock.replace('{number}', '1')));
    expect(root.querySelector('.waits')).toBeNull();
  });

  it('shows the meaning of a milestone, and only the name of a summary', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'm');
    expect(single(root, '.hint').textContent).toBe(TEXT.milestoneHint);
    expect(root.querySelector('fieldset')).toBeNull();
    click(button(root, TEXT.cancel));
    openFor(app, 's');
    expect(root.querySelectorAll('input')).toHaveLength(1);
  });

  it('closes when its task disappears, and when the dialog is closed with Escape', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'a');
    expect(app.edit((context) => deleteTasks(context, ['a']))).toBe(true);
    await settle();
    update();
    expect([dialogIn(root).open, app.detailsTaskId]).toEqual([false, null]);
    app.undo();
    await settle();
    openFor(app, 'a');
    const dialog = dialogIn(root);
    dialog.dispatchEvent(new Event('close'));
    update();
    expect([dialog.open, app.detailsTaskId]).toEqual([true, 'a']);
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    update();
    expect(app.detailsTaskId).toBeNull();
  });
});

describe('TaskDetails fields of work tasks and blocks', () => {
  it('applies the start, hours per day, daily start and the fields of each block', async () => {
    const { app, root } = await renderDetails();
    openFor(app, 'b');
    type(field(root, TEXT.start), '2026-09-29T09:00');
    type(field(root, TEXT.hoursPerDay), '4');
    type(field(root, TEXT.dailyStart), '13:00');
    type(field(root, TEXT.blockDuration.replace('{number}', '1')), '6');
    type(field(root, TEXT.blockGap.replace('{previous}', '1')), '2');
    type(field(root, TEXT.blockStart.replace('{number}', '2')), '2026-10-05T13:00');
    type(field(root, TEXT.blockWaitsFor.replace('{number}', '2')), '1.1');
    submit(root);
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
    expect(app.detailsTaskId).toBeNull();
    const task = app.project?.tasks.find((candidate) => candidate.id === 'b');
    expect(task).toMatchObject({
      hoursPerDay: 4,
      dailyStartHour: 13,
      segments: [{ durationHours: 6 }, { gapDaysBefore: 2 }],
    });
    expect(app.project?.dependencies).toMatchObject([
      { predecessorId: 'a', successorId: 'b', successorBlock: 1 },
    ]);
  });
});
