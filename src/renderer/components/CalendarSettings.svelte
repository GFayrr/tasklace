<script lang="ts">
  import type { Project } from '../../core/model/project';
  import type { Weekday } from '../../core/time';
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';
  import { formatDuration } from '../plan/durations';
  import {
    addNonWorkingPeriod,
    addTimeRange,
    dayRangeText,
    removeNonWorkingPeriod,
    removeTimeRange,
    setNonWorkingPeriod,
    setTimeRange,
    setWorkingWeekday,
    timeRangeText,
    workingHoursOf,
  } from '../plan/project-commands';
  import type { Edit, EditContext } from '../plan/task-commands';
  import { createWeekdayNamer } from '../i18n/format';
  import { commitField } from './commit-field';
  import Icon from './Icon.svelte';

  type Section = 'days' | 'hours' | 'periods';

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
  const weekdayName = $derived(createWeekdayNamer(app.locale));
  const calendar = $derived(project.calendar);
  const dayHours = $derived(
    formatDuration(workingHoursOf(calendar), app.messages, (value) =>
      new Intl.NumberFormat(app.locale).format(value),
    ),
  );
  let refusal = $state<{
    readonly section: Section;
    readonly text: string;
    readonly resets: number;
  } | null>(null);
  const shownRefusal = $derived(refusal?.resets === app.settingsResets ? refusal : null);

  /** Applies a change of the calendar, showing the reason for a refusal beside the part that was changed, or clearing it once applied, and tells whether it was applied. */
  function change(section: Section, build: (context: EditContext) => Edit): boolean {
    const refused = app.editSettings(build);
    refusal = refused === null ? null : { section, text: refused, resets: app.settingsResets };
    return refused === null;
  }

  /** Applies a change typed in a field, putting the value of the calendar back in the field and holding the settings open once when it is refused. */
  function changeField(
    section: Section,
    build: (context: EditContext) => Edit,
    field: HTMLInputElement,
    current: string,
  ): void {
    if (!change(section, build)) {
      field.value = current;
      app.holdSettingsOpen();
    }
  }
</script>

<div class="calendar">
  <section class="group" aria-labelledby="settings-days">
    <h3 id="settings-days">{text.workingDays}</h3>
    <div class="days">
      {#each WEEK as day (day)}
        {@const worked = calendar.workingWeekdays.includes(day)}
        <button
          type="button"
          class={['day', { on: worked }]}
          aria-pressed={worked}
          onclick={() => {
            change('days', (context) => setWorkingWeekday(context, day, !worked));
          }}>{weekdayName(day)}</button
        >
      {/each}
    </div>
    {#if shownRefusal?.section === 'days'}
      <p class="refusal" role="alert">{shownRefusal.text}</p>
    {/if}
  </section>

  <section class="group" aria-labelledby="settings-hours">
    <div class="group-head">
      <h3 id="settings-hours">{text.workingHours}</h3>
      <span class="derived">{fillMessage(text.hoursPerDay, { hours: dayHours })}</span>
    </div>
    {#each calendar.workingTimeRanges as range, index (index)}
      {@const shown = timeRangeText(range)}
      {@const number = String(index + 1)}
      <div class="row">
        <input
          type="time"
          step="900"
          aria-label={fillMessage(text.rangeStart, { number })}
          value={shown.start}
          {@attach commitField(
            () => shown.start,
            (start, field) => {
              changeField(
                'hours',
                (context) => setTimeRange(context, index, { ...shown, start }),
                field,
                shown.start,
              );
            },
          )}
        />
        <span class="dash">{text.to}</span>
        <input
          type="time"
          step="900"
          aria-label={fillMessage(text.rangeEnd, { number })}
          value={shown.end}
          {@attach commitField(
            () => shown.end,
            (end, field) => {
              changeField(
                'hours',
                (context) => setTimeRange(context, index, { ...shown, end }),
                field,
                shown.end,
              );
            },
          )}
        />
        <button
          type="button"
          class="icon-button"
          aria-label={fillMessage(text.removeRange, { number })}
          title={fillMessage(text.removeRange, { number })}
          onclick={() => {
            change('hours', (context) => removeTimeRange(context, index));
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    {/each}
    {#if shownRefusal?.section === 'hours'}
      <p class="refusal" role="alert">{shownRefusal.text}</p>
    {/if}
    <button
      type="button"
      class="add"
      onclick={() => {
        change('hours', addTimeRange);
      }}
    >
      <Icon name="plus" />
      <span>{text.addRange}</span>
    </button>
  </section>

  <section class="group" aria-labelledby="settings-periods">
    <h3 id="settings-periods">{text.daysOff}</h3>
    {#each calendar.nonWorkingPeriods as period, index (index)}
      {@const shown = dayRangeText(period)}
      {@const number = String(index + 1)}
      <div class="row">
        <input
          type="date"
          aria-label={fillMessage(text.periodFirst, { number })}
          value={shown.first}
          {@attach commitField(
            () => shown.first,
            (first, field) => {
              changeField(
                'periods',
                (context) => setNonWorkingPeriod(context, index, { ...shown, first }),
                field,
                shown.first,
              );
            },
          )}
        />
        <span class="dash">{text.to}</span>
        <input
          type="date"
          aria-label={fillMessage(text.periodLast, { number })}
          value={shown.last}
          {@attach commitField(
            () => shown.last,
            (last, field) => {
              changeField(
                'periods',
                (context) => setNonWorkingPeriod(context, index, { ...shown, last }),
                field,
                shown.last,
              );
            },
          )}
        />
        <button
          type="button"
          class="icon-button"
          aria-label={fillMessage(text.removePeriod, { number })}
          title={fillMessage(text.removePeriod, { number })}
          onclick={() => {
            change('periods', (context) => removeNonWorkingPeriod(context, index));
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    {:else}
      <p class="empty">{text.noDaysOff}</p>
    {/each}
    {#if shownRefusal?.section === 'periods'}
      <p class="refusal" role="alert">{shownRefusal.text}</p>
    {/if}
    <button
      type="button"
      class="add"
      onclick={() => {
        change('periods', addNonWorkingPeriod);
      }}
    >
      <Icon name="plus" />
      <span>{text.addPeriod}</span>
    </button>
  </section>
</div>

<style>
  .calendar {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  h3 {
    margin: 0;
    font-size: var(--font-size);
    font-weight: 600;
  }

  .derived {
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .days {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .day {
    min-width: 48px;
    height: var(--control-height);
    padding: 0 var(--space-2);
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .day.on {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .row input {
    height: var(--control-height);
    padding: 0 var(--space-2);
    font-size: var(--font-size);
    font-variant-numeric: tabular-nums;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .dash {
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .add {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) 0;
    font-size: var(--font-size-small);
    font-weight: 500;
    color: var(--color-text);
    background: none;
    border: 0;
    cursor: pointer;
  }

  .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius);
  }

  .refusal {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }

  .icon-button {
    width: var(--control-height);
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .icon-button:hover {
    background: var(--color-panel);
  }
</style>
