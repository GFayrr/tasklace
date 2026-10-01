<script lang="ts">
  import { tick } from 'svelte';
  import type { Tag, Task, TaskId } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';
  import {
    cellEdit,
    EDITABLE_COLUMNS,
    editorText,
    hourFromPicker,
    isEditable,
    nextColumn,
    pickerValue,
    type CellSource,
    type EditableColumn,
  } from '../plan/cell-editing';
  import { groupIncoming, predecessorText, type PlanRow } from '../plan/plan-outline';
  import { taskCells, type TableFormatters } from '../plan/table-format';
  import { indentTask, moveTask, outdentTask } from '../plan/task-commands';
  import { ROW_HEIGHT } from '../plan/timeline-geometry';
  import { visibleRows } from '../plan/timeline-painter';
  import Icon from './Icon.svelte';

  interface Props {
    readonly app: AppState;
    readonly formatters: TableFormatters;
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly scrollBy: (delta: number) => void;
    readonly reveal: (row: number) => void;
  }

  interface Editing {
    readonly taskId: TaskId;
    readonly column: EditableColumn;
    readonly initial: string;
    readonly text: string;
  }

  let { app, formatters, scrollTop, viewportHeight, scrollBy, reveal }: Props = $props();

  const OVERSCAN_ROWS = 4;
  const INDENT_PIXELS = 16;
  const NAME_PADDING = 4;
  const ROW_INDEX_OFFSET = 2;
  const text = $derived(app.messages.table);
  const rows = $derived(app.outline.rows);
  const incoming = $derived(groupIncoming(app.project?.dependencies ?? []));
  const tagsById = $derived(new Map((app.project?.tags ?? []).map((tag) => [tag.id, tag])));
  const tagChoices = $derived(
    [...(app.project?.tags ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name, app.locale),
    ),
  );
  const source: CellSource = $derived({
    schedule: app.schedule,
    calendar: app.calendar,
    incoming,
    wbsById: app.outline.wbsById,
    format: app.regionalFormat,
  });
  const range = $derived(
    visibleRows({ left: 0, top: scrollTop, width: 0, height: viewportHeight }, rows.length),
  );
  const shown = $derived.by(() => {
    const first = Math.max(0, range.first - OVERSCAN_ROWS);
    const last = Math.min(rows.length - 1, range.last + OVERSCAN_ROWS);
    return rows.slice(first, last + 1).map((row, offset) => ({
      row,
      index: first + offset,
      values: cellValues(row),
    }));
  });
  const selectedIndex = $derived(
    app.selectedTaskId === null ? -1 : (app.outline.rowIndexById.get(app.selectedTaskId) ?? -1),
  );
  let activeColumn = $state<EditableColumn>('name');
  let picker: HTMLInputElement | undefined = $state();
  let picking: { readonly taskId: TaskId; readonly column: EditableColumn } | null = null;
  let editing = $state<Editing | null>(null);
  let grid: HTMLDivElement | undefined = $state();

  $effect(() => {
    const request = app.editRequest;
    if (request !== null) {
      app.editRequest = null;
      startEditing(request.taskId, request.column, null);
    }
  });

  /** Returns the texts a row shows in each editable column. */
  function cellValues(row: PlanRow): Readonly<Record<EditableColumn, string>> {
    const cells = taskCells(row.task, app.schedule, app.calendar, formatters, app.messages);
    return {
      name: row.task.name,
      duration: cells.duration,
      start: cells.start,
      end: cells.end,
      progress: cells.progress,
      predecessors: predecessorText(incoming.get(row.task.id), app.outline.wbsById),
      tag: tagOf(row.task)?.name ?? '',
    };
  }

  /** Returns the tag of a task, if it has one. */
  function tagOf(task: Task): Tag | undefined {
    return task.kind === 'summary' || task.tagId === null ? undefined : tagsById.get(task.tagId);
  }

  /** Returns the identifier of the element showing a cell. */
  function cellId(taskId: TaskId, column: EditableColumn): string {
    return `cell-${taskId}-${column}`;
  }

  /** Opens the editor of a cell, starting with its current text or with a typed character. */
  function startEditing(taskId: TaskId, column: EditableColumn, typed: string | null): void {
    const task = app.project?.tasks.find((candidate) => candidate.id === taskId);
    const index = app.outline.rowIndexById.get(taskId);
    if (task === undefined || index === undefined || !isEditable(task, column)) {
      return;
    }
    app.selectedTaskId = taskId;
    activeColumn = column;
    reveal(index);
    const initial = editorText(task, column, source);
    editing = { taskId, column, initial, text: typed ?? initial };
    void tick().then(() => {
      const input = grid?.querySelector<HTMLInputElement | HTMLSelectElement>('.editor');
      if (input === undefined || input === null || document.activeElement === input) {
        return;
      }
      input.focus();
      if (typed === null && input instanceof HTMLInputElement) {
        input.select();
      }
    });
  }

  /** Applies the text of the open editor when it changed, then closes it. */
  function commit(input: HTMLInputElement | HTMLSelectElement): void {
    const current = editing;
    if (current === null) {
      return;
    }
    editing = null;
    if (input.value !== current.initial) {
      app.edit((context) => cellEdit(context, current.taskId, current.column, input.value, source));
    }
    grid?.focus();
  }

  /** Closes the editor without applying anything. */
  function cancel(): void {
    editing = null;
    grid?.focus();
  }

  /** Handles the keys of the open editor: Enter applies and goes down, Escape cancels, Tab applies and goes across. */
  function editorKey(
    event: KeyboardEvent & { currentTarget: HTMLInputElement | HTMLSelectElement },
  ): void {
    const input = event.currentTarget;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(input);
      selectRow(selectedIndex + 1);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const column = activeColumn;
      const taskId = editing?.taskId;
      commit(input);
      if (taskId !== undefined) {
        startEditing(taskId, nextColumn(column, event.shiftKey ? -1 : 1), null);
      }
    }
  }

  /** Opens the calendar of the system under a start or end cell, starting at the date the cell shows. */
  function openPicker(taskId: TaskId, column: EditableColumn, anchor: Element): void {
    const task = app.project?.tasks.find((candidate) => candidate.id === taskId);
    const placement = app.schedule?.placements.get(taskId);
    if (picker === undefined || task === undefined || task.kind === 'summary') {
      return;
    }
    const cell = anchor.getBoundingClientRect();
    const table = grid?.getBoundingClientRect();
    picker.style.left = `${String(cell.left - (table?.left ?? 0))}px`;
    picker.style.top = `${String(cell.bottom - (table?.top ?? 0))}px`;
    const shown = column === 'end' ? placement?.end : (task.startNoEarlierThan ?? placement?.start);
    picker.value = shown === undefined ? '' : pickerValue(shown);
    picking = { taskId, column };
    app.selectedTaskId = taskId;
    activeColumn = column;
    try {
      picker.showPicker();
    } catch (error) {
      picking = null;
      console.error(error);
    }
  }

  /** Applies the date and time chosen on the calendar. */
  function applyPicked(): void {
    const target = picking;
    const hour = picker === undefined ? null : hourFromPicker(picker.value);
    picking = null;
    if (target === null || hour === null) {
      return;
    }
    const text = pickerValue(hour);
    app.edit((context) => cellEdit(context, target.taskId, target.column, text, source));
    grid?.focus();
  }

  /** Selects the row at an index, when it exists, and brings it into view. */
  function selectRow(index: number): void {
    const row = rows[index];
    if (row !== undefined) {
      app.selectedTaskId = row.task.id;
      reveal(index);
    }
  }

  /** Handles the keys of the table while no cell is edited. */
  function gridKey(event: KeyboardEvent): void {
    if (
      editing !== null ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    const handled = handleGridKey(event);
    if (handled) {
      event.preventDefault();
    }
  }

  /** Runs the action of a key of the table, telling whether the key was used. */
  function handleGridKey(event: KeyboardEvent): boolean {
    const id = app.selectedTaskId;
    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      app.editSelected(event.key === 'ArrowRight' ? indentTask : outdentTask);
      return true;
    }
    if (event.altKey && event.key === 'Enter' && id !== null) {
      app.openDetails(id);
      return true;
    }
    if (event.altKey && event.key === 'ArrowDown' && id !== null && isDateColumn(activeColumn)) {
      const cell = document.getElementById(cellId(id, activeColumn));
      if (cell !== null) {
        openPicker(id, activeColumn, cell);
      }
      return true;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      app.editSelected((context, taskId) => moveTask(context, taskId, direction));
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }
    switch (event.key) {
      case 'ArrowUp':
        selectRow(selectedIndex < 0 ? 0 : selectedIndex - 1);
        return true;
      case 'ArrowDown':
        selectRow(selectedIndex + 1);
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        activeColumn = nextColumn(activeColumn, event.key === 'ArrowLeft' ? -1 : 1);
        return true;
      case 'Home':
        selectRow(0);
        return true;
      case 'End':
        selectRow(rows.length - 1);
        return true;
      case 'Enter':
      case 'F2':
        if (id !== null) {
          startEditing(id, activeColumn, null);
        }
        return true;
      case 'Insert':
        app.addTask();
        return true;
      case 'Delete':
        if (id !== null) {
          app.deleteSelected();
        }
        return true;
      default:
        return startTyping(event, id);
    }
  }

  /** Opens the editor of the active cell with a typed character, as in a spreadsheet. */
  function startTyping(event: KeyboardEvent, id: TaskId | null): boolean {
    if (id === null || event.key.length !== 1 || activeColumn === 'tag') {
      return false;
    }
    startEditing(id, activeColumn, event.key);
    return true;
  }

  /** Forwards the wheel to the timeline, which owns the vertical scroll of both panes. */
  function forwardWheel(event: WheelEvent): void {
    if (event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    scrollBy(event.deltaY);
  }

  /** Selects a row and the column that was clicked, keeping the keyboard on the table. */
  function clickCell(event: PointerEvent, taskId: TaskId, column: EditableColumn | null): void {
    if (!(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      grid?.focus();
    }
    app.selectedTaskId = taskId;
    if (column !== null) {
      activeColumn = column;
    }
  }

  /** Tells whether a column holds a date that the calendar can choose. */
  function isDateColumn(column: EditableColumn): boolean {
    return column === 'start' || column === 'end';
  }

  /** Returns the name of a column for assistive technologies. */
  function columnLabel(column: EditableColumn): string {
    return text[column];
  }
</script>

<div
  class="table"
  role="grid"
  tabindex="0"
  aria-label={text.label}
  aria-rowcount={rows.length + ROW_INDEX_OFFSET}
  aria-activedescendant={app.selectedTaskId === null
    ? undefined
    : cellId(app.selectedTaskId, activeColumn)}
  bind:this={grid}
  onwheel={forwardWheel}
  onkeydown={gridKey}
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
      <span class="cell tag" role="columnheader">{text.tag}</span>
    </div>
  </div>
  <input
    class="picker"
    type="datetime-local"
    step="900"
    tabindex="-1"
    aria-hidden="true"
    bind:this={picker}
    onchange={applyPicked}
  />
  <div class="body" role="rowgroup">
    <div class="rows" style:transform="translateY({-scrollTop}px)">
      {#each shown as { row, index, values } (row.task.id)}
        {@const selected = row.task.id === app.selectedTaskId}
        <div
          class="row"
          class:selected
          class:summary={row.task.kind === 'summary'}
          role="row"
          aria-rowindex={index + ROW_INDEX_OFFSET}
          aria-selected={selected}
          style:top="{index * ROW_HEIGHT}px"
        >
          <span
            class="cell wbs"
            role="gridcell"
            tabindex="-1"
            onpointerdown={(event) => {
              clickCell(event, row.task.id, null);
            }}>{row.wbs}</span
          >
          {#each EDITABLE_COLUMNS as column (column)}
            {@const isEditing = editing?.taskId === row.task.id && editing.column === column}
            <span
              class="cell {column}"
              class:number={column === 'duration' || column === 'progress'}
              class:date={column === 'start' || column === 'end'}
              class:active={selected && column === activeColumn}
              id={cellId(row.task.id, column)}
              role="gridcell"
              tabindex="-1"
              aria-readonly={!isEditable(row.task, column)}
              style:padding-left={column === 'name'
                ? `${String(NAME_PADDING + row.depth * INDENT_PIXELS)}px`
                : undefined}
              onpointerdown={(event) => {
                clickCell(event, row.task.id, column);
              }}
              ondblclick={() => {
                startEditing(row.task.id, column, null);
              }}
            >
              {#if column === 'name'}
                {#if row.hasChildren}
                  <button
                    type="button"
                    class="toggle"
                    class:collapsed={row.collapsed}
                    tabindex="-1"
                    aria-expanded={!row.collapsed}
                    aria-label={fillMessage(row.collapsed ? text.expand : text.collapse, {
                      name: row.task.name,
                    })}
                    onclick={() => {
                      app.toggleSummary(row.task.id);
                    }}
                  >
                    <Icon name="chevron" />
                  </button>
                {:else}
                  <span class="toggle-space"></span>
                {/if}
              {/if}
              {#if isEditing && column === 'tag'}
                <select
                  class="editor"
                  value={editing?.text}
                  aria-label={fillMessage(text.editCell, {
                    column: columnLabel(column),
                    name: row.task.name,
                  })}
                  onchange={(event) => {
                    commit(event.currentTarget);
                  }}
                  onkeydown={editorKey}
                  onblur={(event) => {
                    commit(event.currentTarget);
                  }}
                >
                  <option value="">{text.noTag}</option>
                  {#each tagChoices as tag (tag.id)}
                    <option value={tag.id}>{tag.name}</option>
                  {/each}
                </select>
              {:else if isEditing}
                <input
                  class="editor"
                  value={editing?.text}
                  aria-label={fillMessage(text.editCell, {
                    column: columnLabel(column),
                    name: row.task.name,
                  })}
                  onkeydown={editorKey}
                  onblur={(event) => {
                    commit(event.currentTarget);
                  }}
                />
              {:else}
                {#if column === 'tag' && tagOf(row.task) !== undefined}
                  <span class="swatch" style:background={tagOf(row.task)?.color}></span>
                {/if}
                <span class="label">{values[column]}</span>
                {#if isDateColumn(column) && row.task.kind !== 'summary'}
                  <button
                    type="button"
                    class="pick"
                    tabindex="-1"
                    aria-label={fillMessage(text.pickDate, {
                      column: columnLabel(column).toLowerCase(),
                      name: row.task.name,
                    })}
                    onclick={(event) => {
                      openPicker(row.task.id, column, event.currentTarget);
                    }}
                  >
                    <Icon name="calendar" />
                  </button>
                {/if}
              {/if}
            </span>
          {/each}
        </div>
      {/each}
      <div
        class="row add-row"
        role="row"
        aria-rowindex={rows.length + ROW_INDEX_OFFSET}
        style:top="{rows.length * ROW_HEIGHT}px"
      >
        <span class="cell add-cell" role="gridcell">
          <button
            type="button"
            class="add"
            tabindex="-1"
            onclick={() => {
              app.addTask();
            }}
          >
            <Icon name="plus" />
            <span>{text.addTask}</span>
          </button>
        </span>
      </div>
    </div>
  </div>
</div>

<style>
  .table {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--color-surface);
    outline-offset: -2px;
  }

  .header,
  .body {
    width: max(100%, 1010px);
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
    background: var(--color-background);
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
    background: var(--color-surface);
    cursor: default;
  }

  .rows .row.selected {
    background: var(--color-selection);
  }

  .rows .row.selected .wbs {
    box-shadow: inset 3px 0 0 var(--color-action);
  }

  .row.summary {
    font-weight: 600;
  }

  .cell {
    flex-shrink: 0;
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
  }

  .head .cell {
    height: auto;
  }

  .cell.active {
    box-shadow: inset 0 0 0 2px var(--color-focus);
  }

  .table:not(:focus-within) .cell.active {
    box-shadow: none;
  }

  .wbs {
    position: sticky;
    left: 0;
    z-index: 1;
    width: 56px;
    color: var(--color-text-secondary);
    background: inherit;
  }

  .name {
    position: sticky;
    left: 56px;
    z-index: 1;
    width: 200px;
    gap: 2px;
    background: inherit;
    border-right: 1px solid var(--color-grid-line);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .number {
    width: 88px;
    justify-content: flex-end;
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

  .tag {
    width: 150px;
    gap: 6px;
  }

  .swatch {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .editor {
    width: 100%;
    min-width: 0;
    height: 26px;
    padding: 0 4px;
    font-weight: 400;
    border: 1px solid var(--color-focus);
    border-radius: 4px;
    background: var(--color-surface);
    outline: none;
  }

  .picker {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }

  .date {
    gap: 4px;
  }

  .pick {
    width: 22px;
    height: 22px;
    margin-left: auto;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    visibility: hidden;
  }

  .row:hover .pick,
  .row.selected .pick {
    visibility: visible;
  }

  .pick:hover {
    color: var(--color-text);
    background: var(--color-panel);
  }

  .pick :global(.icon) {
    width: 15px;
    height: 15px;
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

  .add-row {
    border-bottom: 0;
  }

  .add-cell {
    position: sticky;
    left: 0;
    padding-left: 60px;
  }

  .add {
    height: 28px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  .add:hover {
    color: var(--color-text);
    background: var(--color-panel);
  }
</style>
