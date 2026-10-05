<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MAX_TAG_NAME_LENGTH } from '../../core/limits';
  import type { Project, TagId } from '../../core/model/project';
  import { TAG_PALETTE } from '../../core/tags/tag-palette';
  import { valueAt } from '../../core/table-value';
  import type { AppState } from '../app/app-state.svelte';
  import { countMessage, fillMessage } from '../i18n/messages';
  import {
    addTag,
    isSameColor,
    removeTag,
    renameTag,
    setTagColor,
    setTagRepresentsPerson,
    tagsByName,
    tagsInShownOrder,
    tasksUsingTag,
  } from '../plan/tag-commands';
  import { tagStylesOf } from '../plan/tag-styles';
  import type { Edit, EditContext } from '../plan/task-commands';
  import { commitField } from './commit-field';
  import Icon from './Icon.svelte';
  import TagSwatch from './TagSwatch.svelte';

  interface Deletion {
    readonly id: TagId;
    readonly name: string;
    readonly count: number;
  }

  interface Refusal {
    readonly tagId: TagId | null;
    readonly text: string;
    readonly resets: number;
  }

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const shownOrder = untrack(() => tagsByName(project.tags, app.locale).map((tag) => tag.id));
  const tags = $derived(tagsInShownOrder(project.tags, shownOrder, app.locale));
  const styles = $derived(tagStylesOf(project));
  const patterned = $derived(
    !project.options.alwaysShowPatterns &&
      [...styles.values()].some((style) => style.pattern !== null),
  );
  const PALETTE_COLUMNS = 6;
  const SETTINGS_SWATCH_SIZE = 22;
  const HISTORY_KEYS: ReadonlySet<string> = new Set(['z', 'y']);
  const COLOR_STEPS: Readonly<Record<string, number>> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -PALETTE_COLUMNS,
    ArrowDown: PALETTE_COLUMNS,
  };
  let choosing = $state<TagId | null>(null);
  let knownBeforeAdding = $state<ReadonlySet<TagId> | null>(null);
  let deletion = $state<Deletion | null>(null);
  let refusal = $state<Refusal | null>(null);
  const shownRefusal = $derived(refusal?.resets === app.settingsResets ? refusal : null);
  const listRefusal = $derived(
    shownRefusal !== null && !tags.some((tag) => tag.id === shownRefusal.tagId)
      ? shownRefusal.text
      : null,
  );

  /** Applies a change of the tags, showing the reason for a refusal beside the tag it is about, or below the list when it is about the list or a tag that is gone, or clearing it once applied, and tells whether it was applied. */
  function change(tagId: TagId | null, build: (context: EditContext) => Edit): boolean {
    const refused = app.editSettings(build);
    refusal = refused === null ? null : { tagId, text: refused, resets: app.settingsResets };
    return refused === null;
  }

  /** Adds a tag, remembering the tags there were so that the name of the new one gets the cursor. */
  function add(): void {
    const known = new Set(project.tags.map((tag) => tag.id));
    if (change(null, (context) => addTag(context, text.newTag))) {
      knownBeforeAdding = known;
    }
  }

  /** Puts the cursor in the name of a tag that was just added and selects it, so that it can be renamed at once. */
  function focusIfAdded(id: TagId): (field: HTMLInputElement) => void {
    return (field) => {
      if (knownBeforeAdding !== null && !knownBeforeAdding.has(id)) {
        knownBeforeAdding = null;
        field.focus();
        field.select();
      }
    };
  }

  /** Deletes a tag at once when no task uses it, and asks first otherwise. */
  function askToDelete(id: TagId, name: string): void {
    const count = tasksUsingTag(project, id);
    if (count === 0) {
      remove(id);
      return;
    }
    deletion = { id, name, count };
  }

  /** Deletes the tag the user confirmed, leaving its tasks without a tag. */
  function confirmDeletion(confirmed: Deletion): void {
    deletion = null;
    remove(confirmed.id);
  }

  /** Deletes a tag and moves the focus to the row that takes its place, or to "Add a tag" when none does. */
  function remove(id: TagId): void {
    const index = tags.findIndex((tag) => tag.id === id);
    if (change(id, (context) => removeTag(context, id))) {
      void focusRowAt(index);
    }
  }

  /** Moves the focus to the delete button of a row once the list is up to date, or of the last row, or to "Add a tag" without any row. */
  async function focusRowAt(index: number): Promise<void> {
    await tick();
    const buttons = [...document.querySelectorAll<HTMLElement>('.tags .row .icon-button')];
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next ?? document.querySelector<HTMLElement>('.tags .add'))?.focus();
  }

  /** Keeps undo and redo from changing the tags while the user is asked to confirm a deletion. */
  function holdHistory(dialog: HTMLDialogElement): () => void {
    const hold = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && HISTORY_KEYS.has(event.key.toLowerCase())) {
        event.stopPropagation();
      }
    };
    dialog.addEventListener('keydown', hold);
    return () => {
      dialog.removeEventListener('keydown', hold);
    };
  }

  /** Puts the focus on the color a tag has when its colors open, or on the first color for a color of its own. */
  function focusChosen(palette: HTMLElement): void {
    const chosen = palette.querySelector<HTMLButtonElement>('.color[aria-pressed="true"]');
    (chosen ?? valueAt([...palette.querySelectorAll<HTMLButtonElement>('.color')], 0)).focus();
  }

  /** Gives a tag a palette or custom color and, once applied, closes the colors and gives the focus back to its color button, telling whether it was applied. */
  function choose(id: TagId, color: string): boolean {
    if (!change(id, (context) => setTagColor(context, id, color))) {
      return false;
    }
    choosing = null;
    document.getElementById(`tag-color-${id}`)?.focus();
    return true;
  }

  /** Moves between the palette colors with the arrow keys, and closes the colors with Escape. */
  function moveInPalette(event: KeyboardEvent, id: TagId): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      choosing = null;
      document.getElementById(`tag-color-${id}`)?.focus();
      return;
    }
    const step = Object.hasOwn(COLOR_STEPS, event.key) ? COLOR_STEPS[event.key] : undefined;
    const buttons = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.color'),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (step === undefined || index < 0) {
      return;
    }
    event.preventDefault();
    valueAt(buttons, (index + step + buttons.length) % buttons.length).focus();
  }

  /** Opens the confirmation dialog as a modal while a deletion waits for an answer, and closes it otherwise. */
  function followDeletion(dialog: HTMLDialogElement): void {
    if (deletion !== null && !dialog.open) {
      dialog.showModal();
    } else if (deletion === null && dialog.open) {
      dialog.close();
    }
  }
</script>

<div class="tags">
  {#if tags.length === 0}
    <p class="empty">{text.noTags}</p>
  {:else}
    <div class="head" aria-hidden="true">
      <span>{text.tagColumnColor}</span>
      <span>{text.tagColumnName}</span>
      <span>{text.tagColumnPerson}</span>
      <span></span>
    </div>
  {/if}
  {#each tags as tag (tag.id)}
    {@const style = styles.get(tag.id)}
    {@const values = { name: tag.name }}
    <div class="row">
      <button
        type="button"
        class="swatch-button"
        id={`tag-color-${tag.id}`}
        aria-label={fillMessage(text.tagColor, values)}
        title={fillMessage(text.tagColor, values)}
        aria-expanded={choosing === tag.id}
        onclick={() => {
          choosing = choosing === tag.id ? null : tag.id;
        }}
      >
        <TagSwatch color={tag.color} pattern={style?.pattern ?? null} size={SETTINGS_SWATCH_SIZE} />
      </button>
      <input
        id={`tag-name-${tag.id}`}
        class="name"
        aria-label={fillMessage(text.tagName, values)}
        maxlength={MAX_TAG_NAME_LENGTH}
        value={tag.name}
        {@attach focusIfAdded(tag.id)}
        {@attach commitField(
          () => tag.name,
          (value, field) => {
            if (change(tag.id, (context) => renameTag(context, tag.id, value))) {
              field.value = value.trim();
              return;
            }
            field.value = tag.name;
            app.holdSettingsOpen();
          },
        )}
      />
      <input
        type="checkbox"
        class="person"
        aria-label={fillMessage(text.tagPerson, values)}
        checked={tag.representsPersonOrTeam}
        onchange={(event) => {
          const field = event.currentTarget;
          if (
            !change(tag.id, (context) => setTagRepresentsPerson(context, tag.id, field.checked))
          ) {
            field.checked = tag.representsPersonOrTeam;
          }
        }}
      />
      <button
        type="button"
        class="icon-button"
        aria-label={fillMessage(text.removeTag, values)}
        title={fillMessage(text.removeTag, values)}
        onclick={() => {
          askToDelete(tag.id, tag.name);
        }}
      >
        <Icon name="trash" />
      </button>
      {#if choosing === tag.id}
        <div
          class="palette"
          role="toolbar"
          {@attach focusChosen}
          aria-label={fillMessage(text.tagColor, values)}
          tabindex="-1"
          onkeydown={(event) => {
            moveInPalette(event, tag.id);
          }}
        >
          <div class="colors">
            {#each TAG_PALETTE as color, index (color)}
              <button
                type="button"
                class="color"
                aria-label={fillMessage(text.paletteColor, { number: String(index + 1) })}
                aria-pressed={isSameColor(tag.color, color)}
                style:background-color={color}
                onclick={() => {
                  choose(tag.id, color);
                }}
              ></button>
            {/each}
          </div>
          <label class="custom">
            <input
              type="color"
              value={tag.color}
              onchange={(event) => {
                const field = event.currentTarget;
                if (!choose(tag.id, field.value)) {
                  field.value = tag.color;
                }
              }}
            />
            <span>{text.customColor}</span>
          </label>
        </div>
      {/if}
      {#if style?.isDistinguishable === false}
        <p class="note warning" role="status">{fillMessage(text.indistinct, values)}</p>
      {/if}
      {#if shownRefusal !== null && shownRefusal.tagId === tag.id}
        <p class="note refusal" role="alert">{shownRefusal.text}</p>
      {/if}
    </div>
  {/each}
  {#if patterned}
    <p class="hint">{text.patterned}</p>
  {/if}
  {#if listRefusal !== null}
    <p class="refusal" role="alert">{listRefusal}</p>
  {/if}
  <button type="button" class="add" onclick={add}>
    <Icon name="plus" />
    <span>{text.addTag}</span>
  </button>
</div>

<dialog
  class="confirm"
  aria-labelledby="tag-delete-title"
  {@attach followDeletion}
  {@attach holdHistory}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      deletion = null;
    }
  }}
>
  {#if deletion !== null}
    {@const asked = deletion}
    <h3 id="tag-delete-title">{fillMessage(text.deleteTitle, { name: deletion.name })}</h3>
    <p>{countMessage(text.deleteBody, deletion.count, app.locale)}</p>
    <div class="actions">
      <button
        type="button"
        class="button"
        onclick={() => {
          deletion = null;
        }}>{text.cancel}</button
      >
      <button
        type="button"
        class="button danger"
        onclick={() => {
          confirmDeletion(asked);
        }}>{text.deleteConfirm}</button
      >
    </div>
  {/if}
</dialog>

<style>
  .tags {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) 96px var(--control-height);
    gap: var(--space-2);
    align-items: center;
  }

  .head {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .head span:nth-child(3),
  .person {
    justify-self: center;
  }

  .swatch-button {
    width: 40px;
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .swatch-button[aria-expanded='true'] {
    border-color: var(--color-focus);
  }

  .name {
    height: var(--control-height);
    min-width: 0;
    padding: 0 var(--space-2);
    font-size: var(--font-size);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .person {
    width: 16px;
    height: 16px;
    accent-color: var(--color-action);
  }

  .palette {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .colors {
    display: grid;
    grid-template-columns: repeat(6, 28px);
    gap: var(--space-2);
  }

  .color {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  .color[aria-pressed='true'] {
    outline: 2px solid var(--color-text);
    outline-offset: 2px;
  }

  .custom {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-small);
    font-weight: 500;
    cursor: pointer;
  }

  .custom input {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: none;
  }

  .note {
    grid-column: 2 / -1;
    margin: 0;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .warning {
    color: var(--color-warning);
  }

  .refusal {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }

  .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius);
  }

  .add {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) 0;
    font-size: var(--font-size-small);
    font-weight: 500;
    color: var(--color-text);
    background: none;
    border: 0;
    cursor: pointer;
  }

  .icon-button {
    width: var(--control-height);
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .icon-button:hover {
    background: var(--color-panel);
  }

  .confirm {
    width: min(420px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .confirm::backdrop {
    background: rgb(28 27 25 / 28%);
  }

  .confirm h3 {
    margin: 0 0 var(--space-3);
    font-size: var(--font-size);
    font-weight: 600;
  }

  .confirm p {
    margin: 0 0 var(--space-4);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-3);
    font-weight: 500;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button:hover {
    background: var(--color-panel);
  }

  .button.danger {
    color: var(--color-action-text);
    background: var(--color-error);
    border-color: var(--color-error);
  }
</style>
