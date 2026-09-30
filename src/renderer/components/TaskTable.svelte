<script lang="ts">
  import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
  import type { Dependency, TaskId } from '../../core/model/project';
  import type { Schedule } from '../../core/scheduling/schedule-project';
  import { fillMessage, type Messages } from '../i18n/messages';
  import { predecessorText, type PlanRow } from '../plan/plan-outline';
  import { taskCells, type TableFormatters } from '../plan/table-format';
  import { ROW_HEIGHT } from '../plan/timeline-geometry';
  import { visibleRows } from '../plan/timeline-painter';
  import Icon from './Icon.svelte';

  interface Props {
    readonly rows: readonly PlanRow[];
    readonly incoming: ReadonlyMap<TaskId, readonly Dependency[]>;
    readonly wbsById: ReadonlyMap<TaskId, string>;
    readonly schedule: Schedule | null;
    readonly calendar: CompiledCalendar | null;
    readonly formatters: TableFormatters;
    readonly messages: Messages;
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly selectedTaskId: TaskId | null;
    readonly select: (id: TaskId) => void;
    readonly toggle: (id: TaskId) => void;
    readonly scrollBy: (delta: number) => void;
  }

  let {
    rows,
    incoming,
    wbsById,
    schedule,
    calendar,
    formatters,
    messages,
    scrollTop,
    viewportHeight,
    selectedTaskId,
    select,
    toggle,
    scrollBy,
  }: Props = $props();

  const OVERSCAN_ROWS = 4;
  const INDENT_PIXELS = 16;
  const text = $derived(messages.table);
  const range = $derived(
    visibleRows({ left: 0, top: scrollTop, width: 0, height: viewportHeight }, rows.length),
  );
  const shown = $derived.by(() => {
    const first = Math.max(0, range.first - OVERSCAN_ROWS);
    const last = Math.min(rows.length - 1, range.last + OVERSCAN_ROWS);
    return rows.slice(first, last + 1).map((row, offset) => ({
      row,
      index: first + offset,
      cells: taskCells(row.task, schedule, calendar, formatters, messages),
      predecessors: predecessorText(incoming.get(row.task.id), wbsById),
    }));
  });

  /** Forwards the wheel to the timeline, which owns the vertical scroll of both panes. */
  function forwardWheel(event: WheelEvent): void {
    if (event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    scrollBy(event.deltaY);
  }
</script>

<div
  class="table"
  role="table"
  aria-label={text.label}
  aria-rowcount={rows.length + 1}
  onwheel={forwardWheel}
>
  <div class="header" role="rowgroup">
    <div class="row head" role="row" aria-rowindex={1}>
      <span class="cell wbs" role="columnheader">{text.wbs}</span>
      <span class="cell name" role="columnheader">{text.name}</span>
      <span class="cell number" role="columnheader">{text.duration}</span>
      <span class="cell date" role="columnheader">{text.start}</span>
      <span class="cell date" role="columnheader">{text.end}</span>
      <span class="cell progress number" role="columnheader">{text.progress}</span>
      <span class="cell predecessors" role="columnheader">{text.predecessors}</span>
    </div>
  </div>
  <div class="body" role="rowgroup">
    <div class="rows" style:transform="translateY({-scrollTop}px)">
      {#each shown as { row, index, cells, predecessors } (row.task.id)}
        <div
          class="row"
          class:selected={row.task.id === selectedTaskId}
          class:summary={row.task.kind === 'summary'}
          role="row"
          aria-rowindex={index + 2}
          aria-selected={row.task.id === selectedTaskId}
          tabindex={-1}
          style:top="{index * ROW_HEIGHT}px"
          onpointerdown={() => {
            select(row.task.id);
          }}
        >
          <span class="cell wbs" role="cell">{row.wbs}</span>
          <span
            class="cell name"
            role="cell"
            style:padding-left="{4 + row.depth * INDENT_PIXELS}px"
          >
            {#if row.hasChildren}
              <button
                type="button"
                class="toggle"
                class:collapsed={row.collapsed}
                aria-expanded={!row.collapsed}
                aria-label={fillMessage(row.collapsed ? text.expand : text.collapse, {
                  name: row.task.name,
                })}
                onclick={() => {
                  toggle(row.task.id);
                }}
              >
                <Icon name="chevron" />
              </button>
            {:else}
              <span class="toggle-space"></span>
            {/if}
            <span class="label">{row.task.name}</span>
          </span>
          <span class="cell number" role="cell">{cells.duration}</span>
          <span class="cell date" role="cell">{cells.start}</span>
          <span class="cell date" role="cell">{cells.end}</span>
          <span class="cell progress number" role="cell">{cells.progress}</span>
          <span class="cell predecessors" role="cell">{predecessors}</span>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .table {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--color-surface);
  }

  .header,
  .body {
    width: max(100%, 860px);
  }

  .header {
    flex-shrink: 0;
    height: 48px;
    background: var(--color-background);
    border-bottom: 1px solid var(--color-border);
  }

  .head {
    position: relative;
    height: 100%;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-secondary);
  }

  .body {
    position: relative;
    flex-grow: 1;
    min-height: 0;
    overflow-x: visible;
    overflow-y: clip;
  }

  .rows {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
  }

  .row {
    display: flex;
    align-items: center;
    min-width: 100%;
    width: max-content;
  }

  .rows .row {
    position: absolute;
    left: 0;
    height: 34px;
    border-bottom: 1px solid var(--color-grid-line);
    cursor: default;
  }

  .rows .row.selected {
    background: var(--color-selection);
    box-shadow: inset 3px 0 0 var(--color-action);
  }

  .row.summary {
    font-weight: 600;
  }

  .cell {
    flex-shrink: 0;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wbs {
    width: 56px;
    color: var(--color-text-secondary);
  }

  .name {
    width: 200px;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .number {
    width: 88px;
    text-align: right;
  }

  .progress {
    width: 60px;
  }

  .date {
    width: 156px;
  }

  .predecessors {
    width: 120px;
    color: var(--color-text-secondary);
  }

  .toggle-space {
    width: 20px;
    flex-shrink: 0;
  }

  .toggle {
    width: 20px;
    height: 20px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  .toggle:hover {
    background: var(--color-panel);
  }

  .toggle.collapsed :global(.icon) {
    transform: rotate(-90deg);
  }

  .toggle :global(.icon) {
    width: 14px;
    height: 14px;
  }
</style>
