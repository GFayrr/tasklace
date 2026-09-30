<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { createDayFormatter, projectSpan } from '../i18n/format';
  import { countMessage, fillMessage } from '../i18n/messages';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages);
  const formatDay = $derived(createDayFormatter(app.locale));
  const collator = $derived(new Intl.Collator(app.locale));
  const tags = $derived(
    [...(app.project?.tags ?? [])].sort(
      (left, right) =>
        collator.compare(left.name, right.name) || collator.compare(left.id, right.id),
    ),
  );
  const taskCount = $derived(
    countMessage(text.status.tasks, app.project?.tasks.length ?? 0, app.locale),
  );
  const span = $derived.by(() => {
    const found = app.schedule === null ? null : projectSpan(app.schedule);
    return found === null
      ? null
      : fillMessage(text.status.span, { start: formatDay(found.start), end: formatDay(found.end) });
  });
</script>

<footer class="status-bar">
  <span class="title" id="legend-title">{text.status.tags}</span>
  <ul class="legend" aria-labelledby="legend-title">
    {#each tags as tag (tag.id)}
      <li class="tag">
        <span class="swatch" style:background={tag.color}></span>
        <span>{tag.name}</span>
      </li>
    {:else}
      <li class="empty">{text.status.noTags}</li>
    {/each}
  </ul>
  <div class="spacer"></div>
  <span class="summary">
    <span>{taskCount}</span>
    {#if span !== null}
      <span aria-hidden="true">·</span>
      <span>{span}</span>
    {/if}
  </span>
</footer>

<style>
  .status-bar {
    min-height: 40px;
    padding: var(--space-2) var(--space-4);
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--space-4);
    font-size: var(--font-size-small);
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
  }

  .title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-secondary);
  }

  .legend {
    display: flex;
    flex-wrap: nowrap;
    min-width: 0;
    flex-shrink: 1;
    overflow-x: auto;
    scrollbar-width: thin;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tag {
    flex-shrink: 0;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 4px;
  }

  .empty,
  .summary {
    color: var(--color-text-secondary);
  }

  .summary {
    flex-shrink: 0;
    white-space: nowrap;
    display: flex;
    gap: var(--space-2);
  }

  .spacer {
    flex-grow: 1;
  }
</style>
