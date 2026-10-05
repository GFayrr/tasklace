import { describe, expect, it } from 'vitest';
import type { Project, Tag } from '../../core/model/project';
import { MAX_TAG_NAME_LENGTH, MAX_TAGS } from '../../core/limits';
import { TAG_PALETTE } from '../../core/tags/tag-palette';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import { project, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { removeTag, renameTag } from '../plan/tag-commands';
import { button, click, nth, press, render, single, update } from './testing/render';

const TEXT = english.settings;
const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#2a78d6',
  representsPersonOrTeam: false,
};
const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
const NEAR: Tag = { id: 'near', name: 'Near', color: '#2a78d7', representsPersonOrTeam: false };
const PLAN: Project = project(
  [workTask('a', { tagId: 'design' }), workTask('b', { tagId: 'design' })],
  [],
  { tags: [DESIGN, ALICE, NEAR] },
);

/** Renders the application over a plan and opens the Tags tab of its settings. */
async function renderTags(plan: Project = PLAN) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  const root = render(App, { app });
  app.openSettings();
  update();
  const dialog = single(root, 'dialog.settings') as HTMLDialogElement;
  const tab = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === TEXT.tags,
  );
  if (tab === undefined) {
    throw new Error('No Tags tab');
  }
  click(tab);
  update();
  return { app, root, dialog, ...fake };
}

/** Finds a control of the settings by its accessible name. */
function labelled(root: ParentNode, label: string): HTMLElement {
  const found = root.querySelector(`[aria-label="${label}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Nothing labelled ${label}`);
  }
  return found;
}

/** Finds a field of the settings by its accessible name. */
function field(root: ParentNode, label: string): HTMLInputElement {
  const found = labelled(root, label);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`No field labelled ${label}`);
  }
  return found;
}

/** Types a value in a field and leaves it. */
function type(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('blur'));
  update();
}

/** Returns the label of a tag field built from its message. */
function of(message: string, name: string): string {
  return message.replace('{name}', name);
}

describe('the Tags tab', () => {
  it('lists the tags by name, with their color, pattern and kind', async () => {
    const { dialog } = await renderTags();
    const names = [...dialog.querySelectorAll<HTMLInputElement>('.tags input.name')];
    expect(names.map((field) => field.value)).toEqual(['Alice', 'Design', 'Near']);
    expect(
      [...dialog.querySelectorAll<HTMLInputElement>('.tags input.person')].map(
        (field) => field.checked,
      ),
    ).toEqual([true, false, false]);
    expect(
      [...dialog.querySelectorAll('.tags .swatch')].map((swatch) =>
        swatch.classList.contains('diagonal'),
      ),
    ).toEqual([false, false, true]);
    expect(single(dialog, '.tags .hint').textContent).toBe(TEXT.patterned);
  });

  it('renames a tag, refusing an empty name and the name of another tag', async () => {
    const { app, dialog } = await renderTags();
    const name = field(dialog, of(TEXT.tagName, 'Design'));
    type(name, 'Alice');
    expect(name.value).toBe('Design');
    expect(single(dialog, '[role="alert"]').textContent).toBe(
      english.editErrors.DUPLICATE_TAG_NAME,
    );
    expect(single(dialog, '[role="alert"]').closest('.row')?.querySelector('input.name')).toBe(
      name,
    );
    type(name, ' ');
    expect(single(dialog, '[role="alert"]').textContent).toBe(english.editErrors.EMPTY_TAG_NAME);
    type(name, 'Build ');
    expect(app.project?.tags.find((tag) => tag.id === 'design')?.name).toBe('Build');
    expect(name.value).toBe('Build');
    expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(0);
    type(name, 'Aaron');
    await settle();
    update();
    expect(
      [...dialog.querySelectorAll<HTMLInputElement>('.tags input.name')].map(
        (entry) => entry.value,
      ),
    ).toEqual(['Alice', 'Aaron', 'Near']);
    expect(name.maxLength).toBe(MAX_TAG_NAME_LENGTH);
  });

  it('stays open once on a refused name when Done is clicked, and forgets the refusal when reopened', async () => {
    const { app, dialog } = await renderTags();
    const name = field(dialog, of(TEXT.tagName, 'Design'));
    name.focus();
    name.value = 'Alice';
    click(button(dialog, TEXT.done));
    update();
    expect(app.settingsOpen).toBe(true);
    expect(single(dialog, '[role="alert"]').textContent).toBe(
      english.editErrors.DUPLICATE_TAG_NAME,
    );
    click(button(dialog, TEXT.done));
    update();
    expect(app.settingsOpen).toBe(false);
    app.openSettings();
    update();
    const tab = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent === TEXT.tags,
    );
    click(tab ?? dialog);
    update();
    expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('marks a tag as a person or a team', async () => {
    const { app, dialog } = await renderTags();
    const person = field(dialog, of(TEXT.tagPerson, 'Design'));
    person.checked = true;
    person.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(app.project?.tags.find((tag) => tag.id === 'design')?.representsPersonOrTeam).toBe(true);
  });

  it('chooses a color from the palette with the mouse or the keyboard, or a color of its own', async () => {
    const { app, dialog } = await renderTags();
    const swatch = labelled(dialog, of(TEXT.tagColor, 'Design'));
    click(swatch);
    await settle();
    update();
    expect(swatch.getAttribute('aria-expanded')).toBe('true');
    const colors = [...dialog.querySelectorAll<HTMLButtonElement>('.palette .color')];
    expect(colors.map((color) => color.getAttribute('aria-pressed'))).toEqual(
      TAG_PALETTE.map((color) => String(color === DESIGN.color)),
    );
    expect(document.activeElement).toBe(colors[0]);
    const palette = single(dialog, '.palette');
    press(palette, 'ArrowDown');
    expect(document.activeElement).toBe(colors[6]);
    press(palette, 'ArrowLeft');
    expect(document.activeElement).toBe(colors[5]);
    press(palette, 'ArrowUp');
    expect(document.activeElement).toBe(colors[11]);
    press(palette, 'Home');
    expect(document.activeElement).toBe(colors[11]);
    click(nth(dialog, '.palette .color', 2));
    update();
    expect(app.project?.tags.find((tag) => tag.id === 'design')?.color).toBe(TAG_PALETTE[2]);
    expect(dialog.querySelectorAll('.palette')).toHaveLength(0);
    expect(document.activeElement).toBe(swatch);
    click(swatch);
    await settle();
    update();
    const custom = single(dialog, '.palette input[type="color"]') as HTMLInputElement;
    custom.value = '#ABCDEF';
    custom.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(app.project?.tags.find((tag) => tag.id === 'design')?.color).toBe('#abcdef');
    click(swatch);
    update();
    expect(document.activeElement).toBe(dialog.querySelector('.palette .color'));
    click(swatch);
    update();
    click(swatch);
    await settle();
    update();
    press(single(dialog, '.palette'), 'Escape');
    update();
    expect(dialog.querySelectorAll('.palette')).toHaveLength(0);
    expect([document.activeElement, app.settingsOpen]).toEqual([swatch, true]);
    click(swatch);
    update();
    click(swatch);
    update();
    expect(dialog.querySelectorAll('.palette')).toHaveLength(0);
  });

  it('adds a tag named at once, and warns about a tag that cannot be told apart', async () => {
    const same = Array.from({ length: 7 }, (_unused, index) => ({
      ...DESIGN,
      id: `t${String(index)}`,
      name: `Tag ${String(index)}`,
    }));
    const { app, dialog } = await renderTags(project([], [], { tags: same }));
    expect(dialog.querySelectorAll('.tags .warning')).toHaveLength(0);
    click(button(dialog, TEXT.addTag));
    await settle();
    update();
    const added = app.project?.tags.find((tag) => tag.name === TEXT.newTag);
    expect(added?.color).toBe(TAG_PALETTE[1]);
    expect(document.activeElement?.id).toBe(`tag-name-${added?.id ?? ''}`);
    const newSwatch = labelled(dialog, of(TEXT.tagColor, TEXT.newTag));
    click(newSwatch);
    await settle();
    update();
    click(nth(dialog, '.palette .color', 0));
    update();
    const last = app.project?.tags.at(-1)?.name ?? '';
    expect(single(dialog, '.tags .warning').textContent).toBe(of(TEXT.indistinct, last));
  });

  it('gives no hint about patterns when every tag always shows one, nor when none needs one', async () => {
    const always = await renderTags({
      ...PLAN,
      options: { ...PLAN.options, alwaysShowPatterns: true },
    });
    expect(always.dialog.querySelectorAll('.tags .hint')).toHaveLength(0);
    const apart = await renderTags(project([], [], { tags: [DESIGN] }));
    expect(apart.dialog.querySelectorAll('.tags .hint')).toHaveLength(0);
  });

  it('starts with a message when the project has no tag', async () => {
    const { dialog } = await renderTags(project([], [], { tags: [] }));
    expect(single(dialog, '.tags .empty').textContent).toBe(TEXT.noTags);
  });

  it('deletes an unused tag at once, and asks before deleting a tag in use', async () => {
    const { app, dialog } = await renderTags();
    click(labelled(dialog, of(TEXT.removeTag, 'Near')));
    update();
    expect(app.project?.tags.map((tag) => tag.id).sort()).toEqual(['alice', 'design']);
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    update();
    const confirm = single(dialog, 'dialog.confirm') as HTMLDialogElement;
    expect(confirm.open).toBe(true);
    expect(single(confirm, 'h3').textContent).toBe(of(TEXT.deleteTitle, 'Design'));
    expect(single(confirm, 'p').textContent).toBe(TEXT.deleteBody.other.replace('{count}', '2'));
    click(button(confirm, TEXT.cancel));
    update();
    expect([confirm.open, app.project?.tags.length]).toEqual([false, 2]);
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    update();
    confirm.dispatchEvent(new Event('close'));
    update();
    expect(dialog.querySelectorAll('dialog.confirm h3')).toHaveLength(1);
    confirm.close();
    confirm.dispatchEvent(new Event('close'));
    update();
    expect(dialog.querySelectorAll('dialog.confirm h3')).toHaveLength(0);
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    update();
    click(button(confirm, TEXT.deleteConfirm));
    update();
    expect(confirm.open).toBe(false);
    expect(app.project?.tags.map((tag) => tag.id)).toEqual(['alice']);
    expect(
      app.project?.tasks.map((task) => (task.kind === 'summary' ? 'summary' : task.tagId)),
    ).toEqual([null, null]);
    expect(app.settingsOpen).toBe(true);
  });

  it('tells in the singular when one task uses the tag', async () => {
    const { dialog } = await renderTags(
      project([workTask('a', { tagId: 'design' })], [], { tags: [DESIGN] }),
    );
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    update();
    expect(single(dialog, 'dialog.confirm p').textContent).toBe(
      TEXT.deleteBody.one.replace('{count}', '1'),
    );
  });

  it('marks as chosen a palette color written in capitals', async () => {
    const { dialog } = await renderTags(
      project([], [], { tags: [{ ...DESIGN, color: '#2A78D6' }] }),
    );
    click(labelled(dialog, of(TEXT.tagColor, 'Design')));
    update();
    expect(document.activeElement).toBe(nth(dialog, '.palette .color', 0));
    expect(nth(dialog, '.palette .color', 0).getAttribute('aria-pressed')).toBe('true');
  });

  it('gives the focus to the next row, the last one, or Add a tag after a deletion', async () => {
    const { dialog } = await renderTags(project([], [], { tags: [ALICE, DESIGN, NEAR] }));
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    await settle();
    expect(document.activeElement).toBe(labelled(dialog, of(TEXT.removeTag, 'Near')));
    click(labelled(dialog, of(TEXT.removeTag, 'Near')));
    await settle();
    expect(document.activeElement).toBe(labelled(dialog, of(TEXT.removeTag, 'Alice')));
    click(labelled(dialog, of(TEXT.removeTag, 'Alice')));
    await settle();
    expect(document.activeElement).toBe(button(dialog, TEXT.addTag));
  });

  it('explains below the list a refusal about a tag that is gone, and keeps undo away from the question', async () => {
    const { app, dialog } = await renderTags();
    expect(app.editSettings((context) => renameTag(context, 'near', 'Other'))).toBeNull();
    await settle();
    click(labelled(dialog, of(TEXT.removeTag, 'Design')));
    update();
    const confirm = single(dialog, 'dialog.confirm') as HTMLDialogElement;
    const before = app.project;
    expect(press(confirm, 'z', { ctrlKey: true })).toBe(true);
    expect(press(confirm, 'Y', { metaKey: true })).toBe(true);
    await settle();
    expect(app.project).toBe(before);
    expect(app.editSettings((context) => removeTag(context, 'design'))).toBeNull();
    await settle();
    update();
    click(button(confirm, TEXT.deleteConfirm));
    update();
    const alert = single(dialog, '[role="alert"]');
    expect(alert.textContent).toBe(english.editErrors.NOT_POSSIBLE);
    expect(alert.parentElement?.classList.contains('tags')).toBe(true);
  });

  it('explains below the list why a tag cannot be added', async () => {
    const full = Array.from({ length: MAX_TAGS }, (_unused, index) => ({
      ...DESIGN,
      id: `t${String(index).padStart(3, '0')}`,
      name: `Tag ${String(index)}`,
    }));
    const { app, dialog } = await renderTags(project([], [], { tags: full }));
    click(button(dialog, TEXT.addTag));
    update();
    expect(app.project?.tags).toHaveLength(MAX_TAGS);
    const alert = single(dialog, '[role="alert"]');
    expect(alert.textContent).toBe(english.editErrors.TOO_MANY_TAGS);
    expect(english.editErrors.TOO_MANY_TAGS).toContain(String(MAX_TAGS));
    expect(alert.parentElement?.classList.contains('tags')).toBe(true);
  });

  it('puts back the box and keeps the colors of a tag whose change is refused while a file action runs', async () => {
    const { app, dialog, context } = await renderTags();
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () =>
        new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        }),
    });
    const opening = app.open();
    await settle();
    const person = field(dialog, of(TEXT.tagPerson, 'Design'));
    person.checked = true;
    person.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(person.checked).toBe(false);
    expect(single(dialog, '.row [role="alert"]').textContent).toBe(english.fileErrors.BUSY);
    click(labelled(dialog, of(TEXT.tagColor, 'Design')));
    update();
    click(nth(dialog, '.palette .color', 4));
    update();
    expect(dialog.querySelectorAll('.palette')).toHaveLength(1);
    expect(app.project?.tags.find((tag) => tag.id === 'design')?.color).toBe(DESIGN.color);
    const custom = single(dialog, '.palette input[type="color"]') as HTMLInputElement;
    custom.value = '#abcdef';
    custom.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(custom.value).toBe(DESIGN.color);
    click(labelled(dialog, of(TEXT.removeTag, 'Near')));
    update();
    expect(app.project?.tags).toHaveLength(3);
    expect(single(dialog, '[role="alert"]').closest('.row')?.querySelector('input.name')).toBe(
      field(dialog, of(TEXT.tagName, 'Near')),
    );
    finish({ ok: false, error: { code: 'CANCELLED' } });
    await opening;
  });
});
