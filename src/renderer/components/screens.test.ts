import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { milestone, project, summary, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import StatusBar from './StatusBar.svelte';
import TagPicker from './TagPicker.svelte';
import Toolbar from './Toolbar.svelte';
import Welcome from './Welcome.svelte';
import { button, click, nth, press, render, single, update } from './testing/render';

const TAGS = [
  { id: 'z', name: 'Writing', color: '#3366AA', representsPersonOrTeam: false },
  { id: 'a', name: 'Design', color: '#AA6633', representsPersonOrTeam: false },
];
const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's' }),
    milestone('m', { sortKey: 'b' }),
  ],
  [],
  { name: 'Thesis', tags: TAGS },
);

/** Creates the application state with the sample plan open from its file. */
async function withOpenPlan() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  return { app, ...fake };
}

/** Returns the texts of the elements matching a selector. */
function textsOf(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) =>
    element.textContent.replace(/\s+/g, ' ').trim(),
  );
}

describe('StatusBar', () => {
  it('lists the tags by name in the legend, counts the tasks and gives the span of the project', async () => {
    const { app } = await withOpenPlan();
    const root = render(StatusBar, { app });
    expect(textsOf(root, '.legend li')).toEqual(['Design', 'Writing']);
    expect(single(root, '.summary').textContent).toMatch(/^3 tasks · Sep 28, 2026 – Sep 28, 2026$/);
  });

  it('says when there is no tag and no schedule yet', () => {
    const app = new AppState(fakeAppContext().context);
    const root = render(StatusBar, { app });
    expect(textsOf(root, '.legend li')).toEqual([english.status.noTags]);
    expect(single(root, '.summary').textContent.trim()).toBe('0 tasks');
  });

  it('changes the zoom, showing the chosen level as pressed', async () => {
    const { app } = await withOpenPlan();
    const root = render(StatusBar, { app });
    click(button(root, english.zoom.week));
    expect(app.zoom).toBe('week');
    expect(button(root, english.zoom.week).getAttribute('aria-pressed')).toBe('true');
    expect(button(root, english.zoom.day).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Welcome', () => {
  it('starts a new project, opens one or imports one', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    const root = render(Welcome, { app });
    expect(root.querySelector('#import-kinds')).toBeNull();
    click(nth(root, '.action', 2));
    expect(nth(root, '.action', 2).getAttribute('aria-expanded')).toBe('true');
    for (const target of [
      () => button(root, english.toolbar.importCsv),
      () => button(root, english.toolbar.importJson),
      () => nth(root, '.action', 1),
      () => nth(root, '.action', 0),
    ]) {
      click(target());
      await settle();
    }
    expect(control.calls).toEqual([
      'importProject',
      'importProject',
      'openProject',
      'newProject',
      'adoptProject',
    ]);
    expect(control.imports).toEqual(['csv', 'json']);
  });

  it('lists the recent projects with their folder, and opens one', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    control.recent = [
      { name: 'Thesis', folder: '/school' },
      { name: 'Thesis', folder: '/work' },
    ];
    await app.loadRecentProjects();
    const root = render(Welcome, { app });
    expect(textsOf(root, '.recent-project')).toEqual(['Thesis /school', 'Thesis /work']);
    click(nth(root, '.recent-project', 1));
    await settle();
    expect(control.calls).toContain('openRecentProject');
  });

  it('shows no recent section without recent projects', () => {
    const root = render(Welcome, { app: new AppState(fakeAppContext().context) });
    expect(root.querySelector('.recent')).toBeNull();
  });
});

describe('TagPicker', () => {
  /** Renders the picker over a cell, recording what it chooses and whether it gave up. */
  function renderPicker(value: string | null) {
    const choose = vi.fn();
    const cancel = vi.fn();
    const anchor = { left: 10, bottom: 30, width: 120 } as DOMRect;
    const root = render(TagPicker, {
      tags: TAGS,
      value,
      anchor,
      label: 'Tag',
      noTag: 'No tag',
      choose,
      cancel,
    });
    return { root, list: single(root, '[role="listbox"]'), choose, cancel };
  }

  it('opens under its cell, focused, on the current tag', () => {
    const { list } = renderPicker('a');
    expect(document.activeElement).toBe(list);
    expect(list.style.left).toBe('10px');
    expect(list.style.top).toBe('32px');
    expect(list.getAttribute('aria-activedescendant')).toBe('tag-option-2');
    expect(textsOf(list, '[role="option"]')).toEqual(['No tag', 'Writing', 'Design']);
  });

  it('moves with the arrows within the list and chooses with Enter', () => {
    const { list, choose } = renderPicker(null);
    press(list, 'ArrowUp');
    expect(list.getAttribute('aria-activedescendant')).toBe('tag-option-0');
    press(list, 'ArrowDown');
    press(list, 'ArrowDown');
    press(list, 'ArrowDown');
    expect(list.getAttribute('aria-activedescendant')).toBe('tag-option-2');
    expect(press(list, 'Enter')).toBe(false);
    expect(choose).toHaveBeenCalledWith('a');
  });

  it('chooses with a click, follows the pointer, and gives up with Escape, Tab or a click elsewhere', () => {
    const { root, list, choose, cancel } = renderPicker('z');
    const option = nth(root, '[role="option"]', 0);
    option.dispatchEvent(new PointerEvent('pointerenter'));
    update();
    expect(list.getAttribute('aria-activedescendant')).toBe('tag-option-0');
    click(option);
    expect(choose).toHaveBeenCalledWith(null);
    press(list, 'Escape');
    press(list, 'Tab');
    press(list, 'a');
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});

describe('Toolbar', () => {
  it('shows the project name and whether it is saved, renaming it when the field is left', async () => {
    const { app } = await withOpenPlan();
    const root = render(Toolbar, { app });
    const name = single(root, 'input.name') as HTMLInputElement;
    expect(name.value).toBe('Thesis');
    expect(single(root, '.status').textContent.trim()).toBe(english.saveStatus.saved);
    name.value = 'Launch';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(app.project?.name).toBe('Launch');
    name.value = '   ';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    expect(name.value).toBe('Launch');
  });

  it('restores the name with Escape and leaves the field with Enter', async () => {
    const { app } = await withOpenPlan();
    const root = render(Toolbar, { app });
    const name = single(root, 'input.name') as HTMLInputElement;
    name.focus();
    name.value = 'Typed';
    press(name, 'Escape');
    expect(name.value).toBe('Thesis');
    expect(document.activeElement).not.toBe(name);
    name.focus();
    press(name, 'Enter');
    expect(document.activeElement).not.toBe(name);
  });

  it('enables the task actions only with a selected task, and runs them on it', async () => {
    const { app } = await withOpenPlan();
    const root = render(Toolbar, { app });
    const details = button(root, english.tasks.details);
    expect(details.disabled).toBe(true);
    app.selectedTaskId = 'a';
    update();
    expect(details.disabled).toBe(false);
    click(details);
    expect(app.detailsTaskId).toBe('a');
    click(button(root, english.tasks.milestone));
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')?.kind).toBe('milestone');
    for (const label of [
      english.tasks.outdent,
      english.tasks.indent,
      english.tasks.moveUp,
      english.tasks.moveDown,
    ]) {
      click(button(root, label));
    }
    click(button(root, english.tasks.delete));
    await settle();
    expect(app.project?.tasks.some((task) => task.id === 'a')).toBe(false);
  });

  it('adds tasks, undoes and redoes, and saves', async () => {
    const { app, control } = await withOpenPlan();
    const root = render(Toolbar, { app });
    expect(button(root, english.toolbar.undo).disabled).toBe(true);
    click(button(root, english.tasks.add));
    await settle();
    update();
    expect(app.project?.tasks).toHaveLength(4);
    click(button(root, english.toolbar.undo));
    await settle();
    update();
    expect(app.project?.tasks).toHaveLength(3);
    click(button(root, english.toolbar.redo));
    await settle();
    expect(app.project?.tasks).toHaveLength(4);
    click(button(root, english.toolbar.save));
    await settle();
    expect(control.calls).toContain('saveProject');
  });

  it('offers new, open, recent, import and export through its menus', async () => {
    const { app, control } = await withOpenPlan();
    control.recent = [{ name: 'Old', folder: '/school' }];
    await app.loadRecentProjects();
    const root = render(Toolbar, { app });
    const choose = (menu: string, item: string): void => {
      click(button(root, menu));
      const entry = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (candidate) => candidate.textContent.trim().startsWith(item),
      );
      if (entry === undefined) {
        throw new Error(item);
      }
      click(entry);
    };
    const chooseAndWait = async (menu: string, item: string): Promise<void> => {
      choose(menu, item);
      await settle();
    };
    await chooseAndWait(english.toolbar.open, english.toolbar.openFile);
    await chooseAndWait(english.toolbar.open, 'Old');
    await chooseAndWait(english.toolbar.import, english.toolbar.importCsv);
    await chooseAndWait(english.toolbar.import, english.toolbar.importJson);
    await chooseAndWait(english.toolbar.export, english.toolbar.exportCsv);
    await chooseAndWait(english.toolbar.export, english.toolbar.exportJson);
    click(button(root, english.toolbar.new));
    await settle();
    expect(
      control.calls.filter((call) => call !== 'recentProjects' && call !== 'adoptProject'),
    ).toEqual([
      'openProject',
      'openProject',
      'openRecentProject',
      'importProject',
      'importProject',
      'regionalFormat',
      'exportProject',
      'exportProject',
      'newProject',
    ]);
    expect(control.imports).toEqual(['csv', 'json']);
    expect(control.exports.map((exported) => exported.kind)).toEqual(['csv', 'json']);
  });

  it('marks a failed save, and a project kept in its local copy only', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    await app.newProject();
    const root = render(Toolbar, { app });
    expect(single(root, '.status').textContent.trim()).toBe(english.saveStatus.localOnly);
    control.saveAsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    click(button(root, english.toolbar.save));
    await settle();
    update();
    expect(single(root, '.status').classList.contains('failed')).toBe(true);
    expect(single(root, '.status').textContent.trim()).toBe(english.saveStatus.failed);
  });
});
