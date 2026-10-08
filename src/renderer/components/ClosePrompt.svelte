<script lang="ts">
  import type { AppState, CloseChoice } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';

  let { app }: { app: AppState } = $props();

  const text = $derived(app.messages.closePrompt);
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (app.closePrompt !== null && dialog?.open === false) {
      dialog.showModal();
    }
  });

  /** Gives the answer of the user and closes the prompt. */
  function answer(choice: CloseChoice): void {
    const prompt = app.closePrompt;
    dialog?.close();
    prompt?.answer(choice);
  }
</script>

<dialog
  class="prompt"
  aria-labelledby="close-prompt-title"
  aria-describedby="close-prompt-body"
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    answer('cancel');
  }}
>
  {#if app.closePrompt?.reason === 'saveFailed'}
    <h2 id="close-prompt-title">{text.failedTitle}</h2>
    <p id="close-prompt-body">{fillMessage(text.failedBody, { reason: app.closePrompt.detail })}</p>
  {:else}
    <h2 id="close-prompt-title">{text.title}</h2>
    <p id="close-prompt-body">{text.body}</p>
  {/if}
  <div class="actions">
    <button
      type="button"
      class="button"
      onclick={() => {
        answer('cancel');
      }}>{text.cancel}</button
    >
    <button
      type="button"
      class="button"
      onclick={() => {
        answer('discard');
      }}>{app.closePrompt?.reason === 'saveFailed' ? text.closeAnyway : text.discard}</button
    >
    <button
      type="button"
      class="button primary"
      onclick={() => {
        answer('save');
      }}>{app.closePrompt?.reason === 'saveFailed' ? text.saveElsewhere : text.save}</button
    >
  </div>
</dialog>

<style>
  .prompt {
    width: min(440px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .prompt::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  h2 {
    margin: 0 0 var(--space-2);
    font-size: 20px;
    font-weight: 600;
  }

  p {
    margin: 0 0 var(--space-6);
    color: var(--color-text-secondary);
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

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button.primary:hover {
    background: var(--color-action-hover);
  }
</style>
