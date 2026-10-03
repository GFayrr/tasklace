<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';

  let { app }: { app: AppState } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (app.report !== null && dialog?.open === false) {
      dialog.showModal();
    }
    if (app.report === null && dialog?.open === true) {
      dialog.close();
    }
  });
</script>

<dialog
  class="report"
  aria-labelledby="report-title"
  bind:this={dialog}
  onclose={() => {
    app.closeReport();
  }}
>
  <h2 id="report-title">{app.report?.title}</h2>
  <ul>
    {#each app.report?.entries ?? [] as entry, index (index)}
      <li>{entry}</li>
    {/each}
  </ul>
  <div class="actions">
    <button
      type="button"
      class="button primary"
      onclick={() => {
        app.closeReport();
      }}>{app.messages.report.close}</button
    >
  </div>
</dialog>

<style>
  .report {
    width: min(560px, calc(100% - 32px));
    max-height: min(560px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .report[open] {
    display: flex;
    flex-direction: column;
  }

  .report::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  h2 {
    margin: 0 0 var(--space-3);
    font-size: 20px;
    font-weight: 600;
  }

  ul {
    margin: 0 0 var(--space-6);
    padding-left: var(--space-4);
    overflow-y: auto;
    color: var(--color-text-secondary);
  }

  li + li {
    margin-top: var(--space-2);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-3);
    font-weight: 500;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border: 1px solid var(--color-action);
  }

  .button.primary:hover {
    background: var(--color-action-hover);
  }
</style>
