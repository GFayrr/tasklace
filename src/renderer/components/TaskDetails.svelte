<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';
  import {
    draftFromTask,
    withAddedBlock,
    withoutBlock,
    type TaskDraft,
  } from '../plan/task-details';
  import { parseDuration } from '../plan/durations';
  import Icon from './Icon.svelte';

  let { app }: { app: AppState } = $props();

  const text = $derived(app.messages.details);
  const task = $derived(app.project?.tasks.find((candidate) => candidate.id === app.detailsTaskId));
  const dayHours = $derived(app.calendar?.workingHoursPerDay ?? 0);
  const tags = $derived(
    [...(app.project?.tags ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name, app.locale),
    ),
  );
  const partDay = $derived.by(() => {
    const written = draft?.hoursPerDay.trim() ?? '';
    const hours = written === '' ? null : parseDuration(written, dayHours);
    return hours !== null && hours < dayHours;
  });
  let dialog: HTMLDialogElement | undefined = $state();
  let draft = $state<TaskDraft | null>(null);
  let refusal = $state<string | null>(null);
  let openedFor: string | null = null;

  $effect(() => {
    const id = app.detailsTaskId;
    if (id === openedFor) {
      return;
    }
    openedFor = id;
    if (task === undefined || dialog === undefined) {
      dialog?.close();
      return;
    }
    draft = draftFromTask(task);
    refusal = null;
    dialog.showModal();
  });

  /** Applies the panel, keeping it open with the reason when the change is refused. */
  function save(event: SubmitEvent): void {
    event.preventDefault();
    if (draft !== null) {
      refusal = app.saveDetails($state.snapshot(draft));
    }
  }

  /** Closes the panel without applying anything. */
  function close(): void {
    app.detailsTaskId = null;
    openedFor = null;
    dialog?.close();
  }
</script>

<dialog class="details" aria-labelledby="details-title" bind:this={dialog} onclose={close}>
  {#if draft !== null && task !== undefined}
    <form onsubmit={save}>
      <h2 id="details-title">{text.title}</h2>
      {#if refusal !== null}
        <p class="refusal" role="alert">{refusal}</p>
      {/if}
      <label class="field">
        <span>{text.name}</span>
        <input bind:value={draft.name} />
      </label>
      {#if task.kind !== 'summary'}
        <div class="pair">
          <label class="field">
            <span>{text.tag}</span>
            <select bind:value={draft.tagId}>
              <option value={null}>{text.noTag}</option>
              {#each tags as tag (tag.id)}
                <option value={tag.id}>{tag.name}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>{text.progress}</span>
            <input inputmode="numeric" bind:value={draft.progress} />
          </label>
        </div>
        <label class="field">
          <span>{text.start}</span>
          <input type="datetime-local" step="900" bind:value={draft.start} />
          <small>{text.startHint}</small>
        </label>
      {/if}
      {#if task.kind === 'task'}
        <div class="pair">
          <label class="field">
            <span>{text.hoursPerDay}</span>
            <input bind:value={draft.hoursPerDay} />
            <small>{text.hoursPerDayHint}</small>
          </label>
          {#if partDay}
            <label class="field">
              <span>{text.dailyStart}</span>
              <input type="time" step="900" bind:value={draft.dailyStart} />
              <small>{text.dailyStartHint}</small>
            </label>
          {/if}
        </div>
        <fieldset class="blocks">
          <legend>{text.blocks}</legend>
          <small>{text.blocksHint}</small>
          {#each draft.blocks as block, index (index)}
            <div class="block">
              {#if index > 0}
                <label class="field gap">
                  <span>{fillMessage(text.blockGap, { previous: String(index) })}</span>
                  <input inputmode="numeric" bind:value={block.gapDays} />
                </label>
              {/if}
              <label class="field">
                <span>{fillMessage(text.blockDuration, { number: String(index + 1) })}</span>
                <input bind:value={block.duration} />
              </label>
              {#if draft.blocks.length > 1}
                <button
                  type="button"
                  class="icon-button"
                  aria-label={fillMessage(text.removeBlock, { number: String(index + 1) })}
                  onclick={() => {
                    if (draft !== null) {
                      draft = withoutBlock(draft, index);
                    }
                  }}
                >
                  <Icon name="trash" />
                </button>
              {/if}
            </div>
          {/each}
          <button
            type="button"
            class="button"
            onclick={() => {
              if (draft !== null) {
                draft = withAddedBlock(draft, dayHours);
              }
            }}
          >
            <Icon name="plus" />
            <span>{text.addBlock}</span>
          </button>
        </fieldset>
      {/if}
      <div class="actions">
        <button type="button" class="button" onclick={close}>{text.cancel}</button>
        <button type="submit" class="button primary">{text.save}</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .details {
    width: min(520px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    padding: 0;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .details::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  form {
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .refusal {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
    font-size: var(--font-size-small);
    font-weight: 500;
  }

  .field input,
  .field select {
    height: var(--control-height);
    padding: 0 var(--space-2);
    font-size: var(--font-size);
    font-weight: 400;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  small {
    font-size: 12px;
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .pair {
    display: flex;
    gap: var(--space-3);
  }

  .blocks {
    margin: 0;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  legend {
    padding: 0 var(--space-1);
    font-weight: 600;
  }

  .block {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
  }

  .gap {
    flex: 0 0 150px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    align-self: flex-start;
    gap: var(--space-1);
    font-weight: 500;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button:hover {
    background: var(--color-panel);
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button.primary:hover {
    background: var(--color-action-hover);
  }

  .icon-button {
    width: var(--control-height);
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .icon-button:hover {
    color: var(--color-text);
    background: var(--color-panel);
  }
</style>
