<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { createPeriodFormatter } from '../i18n/format';
  import Icon from './Icon.svelte';
  import TagSwatch from './TagSwatch.svelte';

  let { app }: { app: AppState } = $props();

  const text = $derived(app.messages.status);
  const formatPeriod = $derived(createPeriodFormatter(app.locale));
  const listFormat = $derived(new Intl.ListFormat(app.locale, { type: 'conjunction' }));
  const lines = $derived(app.conflictLines);
</script>

{#if app.conflictsOpen}
  <section class="list" id="conflict-list" aria-labelledby="conflict-title">
    <div class="head">
      <h2 id="conflict-title">{text.conflictsTitle}</h2>
      <button
        type="button"
        class="icon-button"
        aria-label={text.closeConflicts}
        title={text.closeConflicts}
        onclick={() => {
          app.toggleConflicts();
          document.getElementById('conflict-count')?.focus();
        }}
      >
        <Icon name="close" />
      </button>
    </div>
    <ul>
      {#each lines as line (`${line.conflict.tagId}:${String(line.conflict.start)}`)}
        <li>
          <button
            type="button"
            class="conflict"
            title={text.showConflict}
            onclick={() => {
              app.showConflict(line.conflict);
            }}
          >
            <TagSwatch color={line.color} pattern={line.pattern} />
            <span class="what">
              <span>
                <strong>{line.tagName}</strong>
                <span class="when">{formatPeriod(line.conflict.start, line.conflict.end)}</span>
              </span>
              <span class="tasks">{listFormat.format(line.taskNames)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .list {
    flex-shrink: 0;
    max-height: 30%;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-4);
    overflow-y: auto;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: var(--font-size-small);
    font-weight: 600;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .conflict {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2);
    font: inherit;
    font-size: var(--font-size-small);
    text-align: start;
    color: var(--color-text);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .conflict:hover {
    background: var(--color-selection);
  }

  .conflict :global(.swatch) {
    margin-top: 2px;
  }

  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .when {
    margin-inline-start: var(--space-2);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .tasks {
    color: var(--color-text-secondary);
  }

  .icon-button {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }
</style>
