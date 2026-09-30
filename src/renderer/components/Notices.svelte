<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import Icon from './Icon.svelte';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages);
</script>

<section class="notices" aria-label={text.notices.label}>
  {#each app.notices as notice (notice.id)}
    <div class="notice {notice.kind}" role={notice.kind === 'error' ? 'alert' : 'status'}>
      <Icon name="alert" />
      <p>{notice.text}</p>
      <button
        type="button"
        class="dismiss"
        aria-label={text.notices.dismiss}
        onclick={() => {
          app.dismiss(notice.id);
        }}
      >
        <Icon name="close" />
      </button>
    </div>
  {/each}
</section>

<style>
  .notices {
    position: fixed;
    right: var(--space-4);
    bottom: 56px;
    z-index: 20;
    width: min(420px, calc(100% - 2 * var(--space-4)));
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .notice {
    padding: var(--space-3);
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-left: 4px solid currentColor;
    border-radius: var(--radius);
  }

  .notice.error {
    color: var(--color-error);
  }

  .notice.warning {
    color: var(--color-warning);
  }

  p {
    flex-grow: 1;
    margin: 0;
    color: var(--color-text);
  }

  .dismiss {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    cursor: pointer;
  }

  .dismiss:hover {
    background: var(--color-panel);
  }
</style>
