<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { createDayFormatter, projectSpan } from '../i18n/format';
  import { countMessage, fillMessage } from '../i18n/messages';
  import { tagsByName } from '../plan/tag-commands';
  import { tagStylesOf } from '../plan/tag-styles';
  import Icon from './Icon.svelte';
  import TagSwatch from './TagSwatch.svelte';
  import { ZOOM_LEVELS } from '../plan/time-scale';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages);
  const formatDay = $derived(createDayFormatter(app.locale));
  const tags = $derived(tagsByName(app.project?.tags ?? [], app.locale));
  const styles = $derived(tagStylesOf(app.project));
  const conflictCount = $derived(app.schedule?.tagConflicts.conflicts.length ?? 0);
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
        <TagSwatch color={tag.color} pattern={styles.get(tag.id)?.pattern ?? null} />
        <span>{tag.name}</span>
      </li>
    {:else}
      <li class="empty">{text.status.noTags}</li>
    {/each}
  </ul>
  {#if app.schedule?.floats != null}
    <span class="critical-key">
      <span class="critical-mark" aria-hidden="true"></span>
      <span>{text.status.critical}</span>
    </span>
  {/if}
  {#if conflictCount > 0}
    <button
      type="button"
      class="conflicts"
      id="conflict-count"
      title={text.status.conflictsHint}
      aria-expanded={app.conflictsOpen}
      aria-controls="conflict-list"
      onclick={() => {
        app.toggleConflicts();
      }}
    >
      <span>{countMessage(text.status.conflicts, conflictCount, app.locale)}</span>
      <Icon name="chevron" />
    </button>
  {/if}
  <div class="spacer"></div>
  <span class="summary">
    <span>{taskCount}</span>
    {#if span !== null}
      <span aria-hidden="true">·</span>
      <span>{span}</span>
    {/if}
  </span>
  <div class="zoom" role="group" aria-label={text.zoom.label}>
    {#each ZOOM_LEVELS as level (level)}
      <button
        type="button"
        class="zoom-level"
        aria-pressed={app.zoom === level}
        onclick={() => (app.zoom = level)}
      >
        {text.zoom[level]}
      </button>
    {/each}
  </div>
</footer>

<style>
  .status-bar {
    min-height: 40px;
    padding: var(--space-1) var(--space-4);
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

  .critical-key {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .critical-mark {
    width: 18px;
    height: 3px;
    border-radius: 2px;
    background: var(--color-action);
  }

  .conflicts {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    height: 24px;
    padding: 0 var(--space-3);
    font-size: var(--font-size-small);
    font-weight: 500;
    color: var(--color-error);
    background: var(--color-surface);
    border: 1px solid currentColor;
    border-radius: 999px;
    cursor: pointer;
  }

  .conflicts[aria-expanded='false'] :global(svg) {
    transform: rotate(180deg);
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
  .zoom {
    flex-shrink: 0;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius);
    background: var(--color-panel);
  }

  .zoom-level {
    height: 24px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    font-size: var(--font-size-small);
    font-weight: 500;
    color: var(--color-text-secondary);
    background: transparent;
    cursor: pointer;
  }

  .zoom-level[aria-pressed='true'] {
    color: var(--color-text);
    background: var(--color-surface);
  }
</style>
