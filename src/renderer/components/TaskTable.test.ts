import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { milestone, project, summary, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import { createTableFormatters } from '../plan/table-format';
import TaskTable from './TaskTable.svelte';
import { button, click, press, render, single, update } from './testing/render';

const DESIGN = { id: 'design', name: 'Design', color: '#3366AA', representsPersonOrTeam: false };
const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a', name: 'Study' }),
    workTask('a', { parentId: 's', sortKey: 'a', name: 'Read' }),
    workTask('b', { parentId: 's', sortKey: 'b', name: 'Write', tagId: 'design' }),
    milestone('m', { sortKey: 'b', name: 'Hand in' }),
  ],
  [],
  { name: 'Thesis', tags: [DESIGN] },
);

/** Renders the task table of the sample plan, returning the table, its grid and the recorded scrolls. */
async function renderTable() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  const scrollBy = vi.fn();
  const reveal = vi.fn();
  const root = render(TaskTable, {
    app,
    formatters: createTableFormatters('en-US'),
    scrollTop: 0,
    viewportHeight: 400,
    scrollBy,
    reveal,
  });
  return { app, root, grid: single(root, '[role="grid"]'), scrollBy, reveal, fake };
}

/** Returns the text of the cells of the row of a task, by column. */
function rowTexts(root: HTMLElement, taskId: string): string[] {
  const cell = single(root, `#cell-${taskId}-name`);
  const row = cell.closest('[role="row"]');
  return [...(row?.querySelectorAll('[role="gridcell"]') ?? [])].map((each) =>
    each.textContent.replace(/\s+/g, ' ').trim(),
  );
}

/** Returns the open cell editor, failing the test when none is open. */
function editor(root: HTMLElement): HTMLInputElement {
  return single(root, 'input.editor') as HTMLInputElement;
}

describe('TaskTable', () => {
  it('shows every task with its number, values and ISO dates, and a row to add a task', async () => {
    const { root } = await renderTable();
    expect(rowTexts(root, 'a')).toEqual([
      '1.1',
      'Read',
      '7 h',
      '2026-09-28 09:00',
      '2026-09-28 17:00',
      '0%',
      '',
      '',
    ]);
    expect(rowTexts(root, 'b')[7]).toBe('Design');
    expect(rowTexts(root, 's')[0]).toBe('1');
    expect(button(root, english.table.addTask).disabled).toBe(false);
  });

  it('selects the clicked cell and moves with the arrows, Home and End', async () => {
    const { app, root, grid, reveal } = await renderTable();
    single(root, '#cell-a-duration').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    update();
    expect(app.selectedTaskId).toBe('a');
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-a-duration');
    press(grid, 'ArrowDown');
    expect(app.selectedTaskId).toBe('b');
    press(grid, 'ArrowRight');
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-b-start');
    press(grid, 'ArrowLeft');
    press(grid, 'ArrowUp');
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-a-duration');
    press(grid, 'End');
    expect(app.selectedTaskId).toBe('m');
    press(grid, 'Home');
    expect(app.selectedTaskId).toBe('s');
    expect(reveal).toHaveBeenLastCalledWith(0);
  });

  it('edits a cell from Enter, applies it with Enter and goes to the next row', async () => {
    const { app, root, grid } = await renderTable();
    app.select('a');
    update();
    press(grid, 'Enter');
    await tick();
    const input = editor(root);
    expect(input.value).toBe('Read');
    expect(document.activeElement).toBe(input);
    input.value = 'Read twice';
    press(input, 'Enter');
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')?.name).toBe('Read twice');
    expect(app.selectedTaskId).toBe('b');
    expect(root.querySelector('input.editor')).toBeNull();
  });

  it('starts editing with a typed character, cancels with Escape, and goes across with Tab', async () => {
    const { app, root, grid } = await renderTable();
    app.select('a');
    update();
    press(grid, 'x');
    await tick();
    expect(editor(root).value).toBe('x');
    press(editor(root), 'Escape');
    expect(root.querySelector('input.editor')).toBeNull();
    expect(app.project?.tasks.find((task) => task.id === 'a')?.name).toBe('Read');
    press(grid, 'F2');
    await tick();
    press(editor(root), 'Tab');
    await tick();
    expect(editor(root).value).toBe('7 h');
    editor(root).value = '14';
    press(editor(root), 'Tab', { shiftKey: true });
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      segments: [{ durationHours: 14 }],
    });
    expect(editor(root).value).toBe('Read');
  });

  it('applies the editor when it loses the focus, and tells why a value was refused', async () => {
    const { app, root } = await renderTable();
    single(root, '#cell-a-progress').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    update();
    await tick();
    editor(root).value = 'half';
    editor(root).dispatchEvent(new FocusEvent('blur'));
    update();
    expect(app.notices.map((notice) => notice.text)).toEqual([english.editErrors.INVALID_PROGRESS]);
  });

  it('opens the editor a new task asks for', async () => {
    const { app, root } = await renderTable();
    app.select('a');
    app.addTask();
    await settle();
    update();
    await tick();
    expect(editor(root).value).toBe(english.table.newTask);
  });

  it('runs the task shortcuts of the keyboard', async () => {
    const { app, root, grid } = await renderTable();
    app.select('m');
    update();
    press(grid, 'ArrowRight', { altKey: true, shiftKey: true });
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'm')?.parentId).toBe('s');
    press(grid, 'ArrowLeft', { altKey: true, shiftKey: true });
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'm')?.parentId).toBeNull();
    press(grid, 'ArrowUp', { altKey: true });
    await settle();
    expect(app.outline.rows[0]?.task.id).toBe('m');
    press(grid, 'ArrowDown', { altKey: true });
    await settle();
    expect(app.outline.rows.at(-1)?.task.id).toBe('m');
    press(grid, 'Enter', { altKey: true });
    expect(app.detailsTaskId).toBe('m');
    press(grid, 'Insert');
    await settle();
    await tick();
    expect(app.project?.tasks).toHaveLength(5);
    press(editor(root), 'Escape');
    press(grid, 'Delete');
    await settle();
    expect(app.project?.tasks).toHaveLength(4);
    expect(press(grid, 'z', { ctrlKey: true })).toBe(true);
  });

  it('folds and unfolds a summary from its button or the keyboard', async () => {
    const { app, root, grid } = await renderTable();
    click(button(root, 'Collapse Study'));
    expect(root.querySelector('#cell-a-name')).toBeNull();
    app.select('s');
    update();
    press(grid, 'ArrowRight', { altKey: true });
    expect(root.querySelector('#cell-a-name')).not.toBeNull();
    expect(press(grid, 'ArrowLeft', { altKey: true })).toBe(false);
    expect(app.collapsed.has('s')).toBe(true);
    expect(root.querySelector('#cell-a-name')).toBeNull();
  });

  it('keeps the plan as it is when folding from the keyboard a task that is not a summary', async () => {
    const { app, root, grid } = await renderTable();
    app.select('a');
    update();
    const before = app.project;
    expect(press(grid, 'ArrowLeft', { altKey: true })).toBe(false);
    expect(press(grid, 'ArrowRight', { altKey: true })).toBe(false);
    expect(app.collapsed.size).toBe(0);
    expect(app.project).toBe(before);
    expect(root.querySelector('#cell-a-name')).not.toBeNull();
  });

  it('leaves the folding keys to the page when no task is selected', async () => {
    const { app, grid } = await renderTable();
    expect(app.selectedTaskId).toBeNull();
    expect(press(grid, 'ArrowLeft', { altKey: true })).toBe(true);
    expect(app.collapsed.size).toBe(0);
  });

  it('chooses a tag from its list, placed under the cell once it is in view', async () => {
    const { app, root, grid } = await renderTable();
    app.select('a');
    update();
    for (let step = 0; step < 6; step += 1) {
      press(grid, 'ArrowRight');
    }
    expect(press(grid, 'x')).toBe(true);
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    press(grid, 'Enter');
    await tick();
    update();
    const list = single(root, '[role="listbox"]');
    press(list, 'ArrowDown');
    press(list, 'Enter');
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({ tagId: 'design' });
    press(grid, 'Enter');
    await tick();
    update();
    press(single(root, '[role="listbox"]'), 'Enter');
    press(grid, 'Enter');
    await tick();
    update();
    press(single(root, '[role="listbox"]'), 'Escape');
    expect(root.querySelector('[role="listbox"]')).toBeNull();
  });

  it('lists the tags by name in the order of the language, whatever their order in the project', async () => {
    const { app, root, grid } = await renderTable();
    /** Builds a tag with an identifier and a name. */
    const tagOf = (id: string, name: string) => ({ ...DESIGN, id, name });
    expect(
      app.tryEdit(() => ({
        ok: true,
        value: [
          { type: 'putTag', tag: tagOf('z', 'Zeta') },
          { type: 'putTag', tag: tagOf('e', 'éclair') },
          { type: 'putTag', tag: tagOf('b', 'beta') },
        ],
      })),
    ).toBeNull();
    await settle();
    app.select('a');
    update();
    for (let step = 0; step < 6; step += 1) {
      press(grid, 'ArrowRight');
    }
    press(grid, 'Enter');
    await tick();
    update();
    const options = [...single(root, '[role="listbox"]').querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent.trim())).toEqual([
      english.table.noTag,
      'beta',
      'Design',
      'éclair',
      'Zeta',
    ]);
  });

  it('sets a date chosen on the calendar of the system, or says when the calendar cannot open', async () => {
    const { app, root, grid } = await renderTable();
    const picker = single(root, 'input.picker') as HTMLInputElement;
    const showPicker = vi.fn();
    Object.assign(picker, { showPicker });
    click(button(root, 'Choose the start of Read on a calendar'));
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(picker.value).toBe('2026-09-28T09:00');
    picker.value = '2026-09-29T10:00';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      startNoEarlierThan: at(2026, 9, 29, 10),
    });
    picker.value = '';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    Object.assign(picker, {
      showPicker: () => {
        throw new DOMException('Not allowed', 'NotAllowedError');
      },
    });
    app.select('b');
    update();
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-b-start');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      press(grid, 'ArrowDown', { altKey: true });
    } finally {
      logged.mockRestore();
    }
    expect(app.notices.map((notice) => notice.text)).toEqual([english.notices.pickerUnavailable]);
  });

  it('lets an unexpected failure of the calendar of the system through, without calling it unavailable', async () => {
    const { app, root, grid } = await renderTable();
    const picker = single(root, 'input.picker');
    const failure = new TypeError('calendar broken');
    Object.assign(picker, {
      showPicker: () => {
        throw failure;
      },
    });
    app.select('b');
    update();
    for (let step = 0; step < 3; step += 1) {
      press(grid, 'ArrowRight');
    }
    const errors: unknown[] = [];
    /** Records an error that reached the window and keeps it from being reported. */
    const listen = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', listen);
    try {
      press(grid, 'ArrowDown', { altKey: true });
    } catch (error) {
      errors.push(error);
    } finally {
      window.removeEventListener('error', listen);
    }
    expect(errors).toEqual([failure]);
    expect(app.notices).toEqual([]);
  });

  it('passes the wheel to the timeline, which scrolls both panes', async () => {
    const { grid, scrollBy } = await renderTable();
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    grid.dispatchEvent(wheel);
    grid.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true }));
    expect(scrollBy.mock.calls).toEqual([[40]]);
    expect(wheel.defaultPrevented).toBe(true);
  });
});

describe('TaskTable edge cases', () => {
  it('does nothing for keys that need a selection when none is made, and selects the first row going up', async () => {
    const { app, root, grid } = await renderTable();
    press(grid, 'Enter');
    press(grid, 'F2');
    press(grid, 'Delete');
    press(grid, 'x');
    expect(root.querySelector('input.editor')).toBeNull();
    expect(app.project?.tasks).toHaveLength(4);
    press(grid, 'ArrowUp');
    expect(app.selectedTaskId).toBe('s');
    press(grid, 'End');
    press(grid, 'ArrowDown');
    expect(app.selectedTaskId).toBe('m');
  });

  it('edits only the name of a summary, and offers no calendar for its dates', async () => {
    const { app, root, grid } = await renderTable();
    single(root, '#cell-s-duration').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    update();
    expect(root.querySelector('input.editor')).toBeNull();
    expect(single(root, '#cell-s-start').querySelector('button')).toBeNull();
    app.select('s');
    update();
    single(root, '#cell-s-start').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    update();
    expect(press(grid, 'ArrowDown', { altKey: true })).toBe(false);
  });

  it('selects a row from its number cell, and adds a task from the last row', async () => {
    const { app, root } = await renderTable();
    const wbs = single(root, '#cell-a-name').closest('[role="row"]')?.querySelector('.wbs');
    if (!(wbs instanceof HTMLElement)) {
      throw new Error('No number cell');
    }
    wbs.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    update();
    expect(app.selectedTaskId).toBe('a');
    click(button(root, english.table.addTask));
    await settle();
    expect(app.project?.tasks).toHaveLength(5);
  });

  it('keeps the editor open for other keys, and lets a click inside it place the caret', async () => {
    const { app, root, grid } = await renderTable();
    app.select('a');
    update();
    press(grid, 'Enter');
    await tick();
    expect(press(editor(root), 'a')).toBe(true);
    const inside = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    editor(root).dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
    expect(root.querySelector('input.editor')).not.toBeNull();
    press(grid, 'ArrowDown');
    expect(app.selectedTaskId).toBe('a');
  });

  it('opens the calendar on the end of a task, and leaves it empty before the schedule is known', async () => {
    const { app, root, grid, fake } = await renderTable();
    const picker = single(root, 'input.picker') as HTMLInputElement;
    Object.assign(picker, { showPicker: vi.fn() });
    click(button(root, 'Choose the end of Read on a calendar'));
    expect(picker.value).toBe('2026-09-28T17:00');
    fake.scheduler.automatic = false;
    fake.control.openResult = openedProjectOf(PLAN);
    await app.open();
    expect(app.schedule).toBeNull();
    update();
    app.select('b');
    update();
    press(grid, 'ArrowDown', { altKey: true });
    expect(picker.value).toBe('');
  });

  it('keeps the tag of a task chosen again, and removes it with No tag', async () => {
    const { app, root, grid } = await renderTable();
    app.select('b');
    update();
    for (let step = 0; step < 6; step += 1) {
      press(grid, 'ArrowRight');
    }
    press(grid, 'Enter');
    await tick();
    update();
    press(single(root, '[role="listbox"]'), 'Enter');
    await settle();
    expect(app.canUndo).toBe(false);
    press(grid, 'Enter');
    await tick();
    update();
    press(single(root, '[role="listbox"]'), 'Home');
    press(single(root, '[role="listbox"]'), 'ArrowUp');
    press(single(root, '[role="listbox"]'), 'ArrowUp');
    press(single(root, '[role="listbox"]'), 'Enter');
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'b')).toMatchObject({ tagId: null });
  });
});
