<script lang="ts">
  import type { SchedulingConflictCode } from '../../core/scheduling/forward-pass';
  import type { AppState } from '../app/app-state.svelte';
  import { createMomentFormatter, createPeriodFormatter } from '../i18n/format';
  import { fillMessage } from '../i18n/messages';
  import Icon from './Icon.svelte';
  import TagSwatch from './TagSwatch.svelte';

  let { app }: { app: AppState } = $props();

  const text = $derived(app.messages.status);
  const formatPeriod = $derived(createPeriodFormatter(app.locale));
  const listFormat = $derived(new Intl.ListFormat(app.locale, { type: 'conjunction' }));
  const formatMoment = $derived(createMomentFormatter(app.locale));
  const lines = $derived(app.conflictLines);
  const dateLines = $derived(app.dateConflictLines);
  const dateTexts = $derived({
    DEADLINE_MISSED: { what: text.deadlineMissed, dates: text.deadlineMissedDates },
    MUST_FINISH_ON_NOT_MET: { what: text.mustFinishOnNotMet, dates: text.mustFinishOnNotMetDates },
  } satisfies Record<SchedulingConflictCode, { readonly what: string; readonly dates: string }>);
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
    {#if lines.length > 0}
      <h3 class="group">
        {text.peopleConflicts}<small>{text.peopleConflictsHint}</small>
      </h3>
    {/if}
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
    {#if dateLines.length > 0}
      <h3 class="group">
        {text.dateConflicts}<small>{text.dateConflictsHint}</small>
      </h3>
    {/if}
    <ul>
      {#each dateLines as line (`${line.conflict.taskId}:${line.conflict.code}`)}
        {@const lineText = dateTexts[line.conflict.code]}
        <li>
          <button
            type="button"
            class="conflict"
            title={text.showConflict}
            onclick={() => {
              app.showDateConflict(line);
            }}
          >
            <span class="alert"><Icon name="alert" /></span>
            <span class="what">
              <span>
                <strong>{line.taskName}</strong>
                <span class="when">{lineText.what}</span>
              </span>
              <span class="tasks">
                {fillMessage(lineText.dates, {
                  end: formatMoment(line.end),
                  date: formatMoment(line.date),
                })}
              </span>
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

  .group {
    margin: var(--space-2) 0 0;
    padding: 0 var(--space-2);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  .group small {
    font-size: 12px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .alert {
    display: flex;
    color: var(--color-error);
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
