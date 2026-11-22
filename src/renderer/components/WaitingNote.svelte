<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';

  let { app }: { app: AppState } = $props();
</script>

<p class="waiting" role="status" aria-live="polite">
  {#if app.waiting !== null}
    <span class="note">{app.messages.waiting[app.waiting]}</span>
  {/if}
</p>

<style>
  .waiting {
    position: fixed;
    top: var(--space-4);
    left: 50%;
    z-index: 30;
    margin: 0;
    transform: translateX(-50%);
    pointer-events: none;
  }

  .note {
    display: block;
    padding: var(--space-2) var(--space-3);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: progress;
  }
</style>
