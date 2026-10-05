import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import { at, dayOf as day } from '../../core/testing/civil-time';
import { project, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, nth, press, render, single, update } from './testing/render';

const TEXT = english.settings;
const PLAN: Project = project([workTask('a', { name: 'Interviews', hoursPerDay: 6 })], [], {
  name: 'Thesis',
  startDate: at(2026, 9, 28, 9),
});

/** Renders the application over the sample plan and opens its settings with the toolbar button. */
async function renderSettings() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  const root = render(App, { app });
  click(button(root, TEXT.open));
  update();
  return { app, root, ...fake, dialog: single(root, 'dialog.settings') as HTMLDialogElement };
}

/** Finds an input of the settings by its label, failing the test when there is none. */
function input(root: ParentNode, label: string): HTMLInputElement {
  const found = root.querySelector(`input[aria-label="${label}"]`);
  if (found instanceof HTMLInputElement) {
    return found;
  }
  const byLabel = [...root.querySelectorAll('label')].find(
    (candidate) => candidate.querySelector('span')?.textContent === label,
  );
  const control = byLabel?.querySelector('input');
  if (!(control instanceof HTMLInputElement)) {
    throw new Error(`No input ${label}`);
  }
  return control;
}

/** Types a value in an input and leaves it, as the user does to hand it over. */
function type(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('blur'));
  update();
}

/** Opens a tab of the settings by its name. */
function openTab(root: ParentNode, name: string): void {
  const tab = [...root.querySelectorAll('[role="tab"]')].find(
    (candidate) => candidate.textContent === name,
  );
  if (!(tab instanceof HTMLElement)) {
    throw new Error(`No tab ${name}`);
  }
  click(tab);
  update();
}

/** Returns the section of the settings a single refusal is shown in, by its heading. */
function refusalSection(root: ParentNode): string | null | undefined {
  return single(root, '[role="alert"]').closest('section')?.getAttribute('aria-labelledby');
}

describe('the project settings', () => {
  it('open on the General tab from the toolbar, and close with Done, the close button or Escape', async () => {
    const { app, root, dialog } = await renderSettings();
    expect(dialog.open).toBe(true);
    expect(app.settingsOpen).toBe(true);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([
      [TEXT.general, 'true'],
      [TEXT.calendar, 'false'],
      [TEXT.tags, 'false'],
      [TEXT.advanced, 'false'],
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      null,
      'true',
    ]);
    openTab(root, TEXT.calendar);
    click(button(dialog, TEXT.done));
    update();
    expect([dialog.open, app.settingsOpen]).toEqual([false, false]);
    app.openSettings();
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.general);
    click(button(dialog, TEXT.close));
    update();
    expect(dialog.open).toBe(false);
    app.openSettings();
    update();
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    update();
    expect([cancel.defaultPrevented, app.settingsOpen]).toEqual([false, false]);
    app.openSettings();
    update();
    dialog.dispatchEvent(new Event('close'));
    expect(app.settingsOpen).toBe(false);
  });

  it('move between the open tabs with the arrow keys, skipping those available later', async () => {
    const { root } = await renderSettings();
    const tablist = single(root, '[role="tablist"]');
    press(tablist, 'ArrowRight');
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.calendar);
    expect(document.activeElement?.id).toBe('settings-tab-calendar');
    press(tablist, 'ArrowRight');
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.tags);
    press(tablist, 'ArrowRight');
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.general);
    expect(document.activeElement?.id).toBe('settings-tab-general');
    press(tablist, 'ArrowLeft');
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.tags);
    press(tablist, 'Enter');
    update();
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.tags);
    openTab(root, TEXT.advanced);
    expect(single(root, '[aria-selected="true"]').textContent).toBe(TEXT.tags);
  });

  it('rename the project and move its start when a field is left or Enter is pressed, telling how many tasks moved', async () => {
    const { app, dialog: root } = await renderSettings();
    const name = single(root, '#settings-project-name') as HTMLInputElement;
    type(name, 'Master thesis');
    await settle();
    expect(app.project?.name).toBe('Master thesis');
    const start = input(root, TEXT.projectStart);
    expect(start.value).toBe('2026-09-28T09:00');
    start.value = '2026-10-05T09:00';
    start.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(app.project?.startDate).toBe(at(2026, 9, 28, 9));
    press(start, 'Escape');
    expect(app.project?.startDate).toBe(at(2026, 9, 28, 9));
    press(start, 'Enter');
    await settle();
    update();
    expect(app.project?.startDate).toBe(at(2026, 10, 5, 9));
    expect(single(root, '[role="status"].notice').textContent).toBe(
      TEXT.tasksMoved.one.replace('{count}', '1'),
    );
    const moved = app.project;
    type(start, '2026-10-05T09:00');
    expect(app.project).toBe(moved);
  });

  it('put the value of the project back in a refused field, and keep the reason until a change is applied', async () => {
    const { app, dialog: root } = await renderSettings();
    const name = single(root, '#settings-project-name') as HTMLInputElement;
    type(name, ' ');
    expect([name.value, app.project?.name]).toEqual(['Thesis', 'Thesis']);
    expect(single(root, '.general [role="alert"]').textContent).toBe(english.issues.EMPTY_TEXT);
    const start = input(root, TEXT.projectStart);
    type(start, '');
    expect(start.value).toBe('2026-09-28T09:00');
    expect(single(root, '.general [role="alert"]').textContent).toBe(
      english.editErrors.INVALID_DATE,
    );
    type(start, '2026-10-05T09:00');
    expect(root.querySelectorAll('.general [role="alert"]')).toHaveLength(0);
  });

  it('change the working days, hours and days off, each change applied at once', async () => {
    const { app, dialog: root } = await renderSettings();
    openTab(root, TEXT.calendar);
    const days = [...root.querySelectorAll('.day')];
    expect(days.map((entry) => [entry.textContent, entry.getAttribute('aria-pressed')])).toEqual([
      ['Mon', 'true'],
      ['Tue', 'true'],
      ['Wed', 'true'],
      ['Thu', 'true'],
      ['Fri', 'true'],
      ['Sat', 'false'],
      ['Sun', 'false'],
    ]);
    click(days[5] as HTMLElement);
    update();
    expect(app.project?.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(single(root, '.derived').textContent).toBe(TEXT.hoursPerDay.replace('{hours}', '7 h'));
    type(input(root, TEXT.rangeEnd.replace('{number}', '2')), '18:00');
    await settle();
    update();
    expect(app.project?.calendar.workingTimeRanges).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 13, endHour: 18 },
    ]);
    expect(single(root, '.derived').textContent).toBe(TEXT.hoursPerDay.replace('{hours}', '8 h'));
    click(button(root, TEXT.addRange));
    update();
    expect(app.project?.calendar.workingTimeRanges).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 13, endHour: 18 },
      { startHour: 19, endHour: 20 },
    ]);
    click(button(root, TEXT.removeRange.replace('{number}', '1')));
    update();
    expect(app.project?.calendar.workingTimeRanges).toEqual([
      { startHour: 13, endHour: 18 },
      { startHour: 19, endHour: 20 },
    ]);
    expect(single(root, '.empty').textContent).toBe(TEXT.noDaysOff);
    click(button(root, TEXT.addPeriod));
    update();
    expect(input(root, TEXT.periodFirst.replace('{number}', '1')).value).toBe('2026-09-28');
    expect(input(root, TEXT.periodLast.replace('{number}', '1')).value).toBe('');
    type(input(root, TEXT.periodLast.replace('{number}', '1')), '2026-10-02');
    type(input(root, TEXT.periodFirst.replace('{number}', '1')), '2026-09-29');
    expect(app.project?.calendar.nonWorkingPeriods).toEqual([
      { firstDay: day(2026, 9, 29), lastDay: day(2026, 10, 2) },
    ]);
    click(button(root, TEXT.removePeriod.replace('{number}', '1')));
    update();
    expect(app.project?.calendar.nonWorkingPeriods).toEqual([]);
  });

  it('show the reason of a refused change beside the part that was changed, naming the task at stake', async () => {
    const { app, dialog: root } = await renderSettings();
    openTab(root, TEXT.calendar);
    const before = app.project?.calendar;
    click(button(root, TEXT.removeRange.replace('{number}', '2')));
    update();
    expect(app.project?.calendar).toBe(before);
    expect(single(root, '[role="alert"]').textContent).toBe(
      TEXT.hoursPerDayTooLong.replace('{name}', 'Interviews').replace('{hours}', '6 h'),
    );
    expect(refusalSection(root)).toBe('settings-hours');
    const end = input(root, TEXT.rangeEnd.replace('{number}', '1'));
    type(end, '14:00');
    expect(end.value).toBe('12:00');
    expect(single(root, '[role="alert"]').textContent).toBe(
      english.issues.OVERLAPPING_WORKING_TIME_RANGES,
    );
    type(input(root, TEXT.rangeStart.replace('{number}', '1')), '10:00');
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(app.project?.calendar.workingTimeRanges[0]).toEqual({ startHour: 10, endHour: 12 });
    for (const entry of [...root.querySelectorAll('.day.on')].slice(1)) {
      click(entry as HTMLElement);
      update();
    }
    click(single(root, '.day.on'));
    update();
    expect(single(root, '[role="alert"]').textContent).toBe(english.issues.NO_WORKING_WEEKDAY);
    expect(refusalSection(root)).toBe('settings-days');
    click(button(root, TEXT.addPeriod));
    update();
    const first = input(root, TEXT.periodFirst.replace('{number}', '1'));
    type(first, '');
    expect(first.value).toBe('2026-09-28');
    expect(single(root, '[role="alert"]').textContent).toBe(english.editErrors.INVALID_DATE);
    expect(refusalSection(root)).toBe('settings-periods');
    type(input(root, TEXT.periodLast.replace('{number}', '1')), '2026-09-20');
    expect(single(root, '[role="alert"]').textContent).toBe(
      english.issues.INVALID_NON_WORKING_PERIOD,
    );
  });

  it('stay open on a refusal made when leaving a field to close them, and forget it when reopened', async () => {
    const { app, dialog: root } = await renderSettings();
    openTab(root, TEXT.calendar);
    const end = input(root, TEXT.rangeEnd.replace('{number}', '1'));
    end.focus();
    end.value = '14:00';
    click(button(root, TEXT.done));
    update();
    expect([root.open, app.settingsOpen]).toEqual([true, true]);
    expect(single(root, '[role="alert"]').textContent).toBe(
      english.issues.OVERLAPPING_WORKING_TIME_RANGES,
    );
    end.focus();
    end.value = '14:00';
    const cancel = new Event('cancel', { cancelable: true });
    root.dispatchEvent(cancel);
    update();
    expect([cancel.defaultPrevented, app.settingsOpen]).toEqual([true, true]);
    click(button(root, TEXT.done));
    update();
    expect(root.open).toBe(false);
    app.openSettings();
    update();
    openTab(root, TEXT.calendar);
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('undo a change with the keyboard while open, and run no other shortcut', async () => {
    const { app, root, control, dialog } = await renderSettings();
    openTab(dialog, TEXT.calendar);
    click(nth(dialog, '.day', 5));
    update();
    expect(app.project?.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
    const saves = control.calls.length;
    const firstDay = single(dialog, '.day[aria-pressed="true"]:first-child');
    press(firstDay, 's', { ctrlKey: true });
    await settle();
    expect(control.calls).toHaveLength(saves);
    press(firstDay, 'z', { ctrlKey: true });
    await settle();
    update();
    expect(app.project?.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(dialog.querySelectorAll('.day[aria-pressed="true"]')).toHaveLength(5);
    press(root, 'y', { ctrlKey: true });
    await settle();
    expect(app.project?.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('show inside them why the dates could not be computed', async () => {
    const { app, dialog, scheduler } = await renderSettings();
    scheduler.automatic = false;
    type(input(dialog, TEXT.projectStart), '2026-10-05T09:00');
    if (app.project === null) {
      throw new Error('The plan closed.');
    }
    scheduler.listener().scheduled({ ok: false, error: { kind: 'startDate' } }, app.project);
    update();
    expect(single(dialog, '.alert').textContent).toBe(english.scheduleFailures.startDate);
  });
});
