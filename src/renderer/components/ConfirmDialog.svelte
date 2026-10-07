<script lang="ts">
  export interface ConfirmQuestion {
    readonly title: string;
    readonly body: string;
    readonly confirm: string;
    readonly danger: boolean;
  }

  interface Props {
    readonly question: ConfirmQuestion | null;
    readonly titleId: string;
    readonly cancel: string;
    readonly confirmed: () => void;
    readonly dismissed: () => void;
  }

  let { question, titleId, cancel, confirmed, dismissed }: Props = $props();

  const HISTORY_KEYS: ReadonlySet<string> = new Set(['z', 'y']);

  /** Opens the dialog as a modal while a question waits for an answer, and closes it otherwise. */
  function followQuestion(dialog: HTMLDialogElement): void {
    if (question !== null && !dialog.open) {
      dialog.showModal();
    } else if (question === null && dialog.open) {
      dialog.close();
    }
  }

  /** Keeps undo and redo from changing the project while the user is asked to confirm. */
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
</script>

<dialog
  class="confirm"
  aria-labelledby={titleId}
  {@attach followQuestion}
  {@attach holdHistory}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      dismissed();
    }
  }}
>
  {#if question !== null}
    <h3 id={titleId}>{question.title}</h3>
    <p>{question.body}</p>
    <div class="actions">
      <button type="button" class="button" onclick={dismissed}>{cancel}</button>
      <button
        type="button"
        class={['button', { primary: !question.danger, danger: question.danger }]}
        onclick={confirmed}>{question.confirm}</button
      >
    </div>
  {/if}
</dialog>

<style>
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

  h3 {
    margin: 0 0 var(--space-3);
    font-size: var(--font-size);
    font-weight: 600;
  }

  p {
    margin: 0 0 var(--space-4);
    font-size: var(--font-size);
    color: var(--color-text);
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
    color: var(--color-text);
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

  .button.danger {
    color: var(--color-action-text);
    background: var(--color-error);
    border-color: var(--color-error);
  }
</style>
