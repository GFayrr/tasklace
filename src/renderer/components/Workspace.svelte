<script lang="ts">
  import { untrack } from 'svelte';
  import { compileCalendar } from '../../core/calendar/compile-calendar';
  import type { TaskId } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { buildPlanOutline, groupIncoming, toggledSummary } from '../plan/plan-outline';
  import { createTableFormatters } from '../plan/table-format';
  import {
    clampTableWidth,
    MIN_TABLE_WIDTH,
    readTableWidth,
    rememberTableWidth,
    TABLE_WIDTH_STEP,
  } from '../plan/table-width';
  import {
    createScaleLabels,
    pixelsPerHour,
    zoomedScrollLeft,
    type ZoomLevel,
  } from '../plan/time-scale';
  import { timelineFrame, xOf } from '../plan/timeline-geometry';
  import { tagStylesOf } from '../plan/tag-styles';
  import { localHourOf } from '../project/new-project';
  import TaskTable from './TaskTable.svelte';
  import Timeline from './Timeline.svelte';

  let { app }: { app: AppState } = $props();

  const TODAY_REFRESH_MS = 60_000;
  const LEAD_DAYS_SHOWN = 2;
  const HOURS_PER_DAY = 24;
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();

  let collapsed = $state.raw<ReadonlySet<TaskId>>(new Set());
  let tableWidth = $state(readTableWidth(storage));
  let containerWidth = $state(0);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportHeight = $state(0);
  let timelineWidth = 0;
  let today = $state(localHourOf(new Date()));

  const project = $derived(app.project);
  const outline = $derived(buildPlanOutline(project?.tasks ?? [], collapsed));
  const incoming = $derived(groupIncoming(project?.dependencies ?? []));
  const calendar = $derived.by(() => {
    const compiled = project === null ? null : compileCalendar(project.calendar);
    return compiled?.ok === true ? compiled.value : null;
  });
  const tagStyles = $derived(tagStylesOf(project));
  const conflictTaskIds = $derived(
    new Set(app.schedule?.tagConflicts.conflicts.flatMap((conflict) => conflict.taskIds) ?? []),
  );
  const frame = $derived(
    timelineFrame(project?.startDate ?? today, app.schedule, today, pixelsPerHour(app.zoom)),
  );
  const formatters = $derived(createTableFormatters(app.locale));
  const labels = $derived(createScaleLabels(app.locale));
  const shownWidth = $derived(clampTableWidth(tableWidth, containerWidth));
  const scene = $derived({
    frame,
    zoom: app.zoom,
    rows: outline.rows,
    rowIndexById: outline.rowIndexById,
    schedule: app.schedule,
    dependencies: project?.dependencies ?? [],
    calendar,
    nonWorkingPeriods: project?.calendar.nonWorkingPeriods ?? [],
    theme: app.theme,
    tagStyles,
    conflictTaskIds,
    selectedTaskId: app.selectedTaskId,
    today,
  });

  $effect(() => {
    const timer = setInterval(() => {
      today = localHourOf(new Date());
    }, TODAY_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  });

  let scrolledForOpening = -1;
  $effect(() => {
    const opening = app.openedCount;
    if (opening === scrolledForOpening) {
      return;
    }
    scrolledForOpening = opening;
    untrack(() => {
      const start = app.project?.startDate;
      if (start !== undefined) {
        scrollTop = 0;
        scrollLeft = Math.max(0, xOf(frame, start - LEAD_DAYS_SHOWN * HOURS_PER_DAY));
      }
    });
  });

  let previousZoom: ZoomLevel = untrack(() => app.zoom);
  $effect.pre(() => {
    const zoom = app.zoom;
    if (zoom === previousZoom) {
      return;
    }
    const from = previousZoom;
    previousZoom = zoom;
    scrollLeft = untrack(() => zoomedScrollLeft(scrollLeft, timelineWidth, from, zoom));
  });

  /** Opens or closes a summary task. */
  function toggle(id: TaskId): void {
    collapsed = toggledSummary(collapsed, id);
  }

  /** Selects a task. */
  function selectTask(id: TaskId): void {
    app.selectedTaskId = id;
  }

  /** Scrolls both panes vertically. */
  function scrollRowsBy(delta: number): void {
    scrollTop = Math.max(0, scrollTop + delta);
  }

  /** Follows the scroll of the timeline. */
  function followScroll(top: number, left: number): void {
    scrollTop = top;
    scrollLeft = left;
  }

  /** Follows the size of the visible part of the timeline. */
  function followSize(width: number, height: number): void {
    timelineWidth = width;
    viewportHeight = height;
  }

  /** Changes the width of the table and remembers it. */
  function setTableWidth(width: number): void {
    tableWidth = clampTableWidth(width, containerWidth);
    rememberTableWidth(storage, tableWidth);
  }

  /** Follows the pointer while the separator is dragged. */
  function dragSeparator(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = shownWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => {
      setTableWidth(startWidth + moved.clientX - startX);
    };
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /** Moves the separator with the arrow keys. */
  function separatorKey(event: KeyboardEvent): void {
    const steps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      setTableWidth(shownWidth + step * TABLE_WIDTH_STEP);
    }
  }
</script>

<main class="workspace" aria-label={app.messages.app.workspace} bind:clientWidth={containerWidth}>
  <div class="table-pane" style:width="{shownWidth}px">
    <TaskTable
      rows={outline.rows}
      {incoming}
      wbsById={outline.wbsById}
      schedule={app.schedule}
      {calendar}
      {formatters}
      messages={app.messages}
      {scrollTop}
      {viewportHeight}
      selectedTaskId={app.selectedTaskId}
      select={selectTask}
      {toggle}
      scrollBy={scrollRowsBy}
    />
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="separator"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label={app.messages.splitter.label}
    aria-valuenow={shownWidth}
    aria-valuemin={MIN_TABLE_WIDTH}
    aria-valuemax={containerWidth}
    onpointerdown={dragSeparator}
    onkeydown={separatorKey}
  ></div>
  <div class="timeline-pane">
    <Timeline
      {scene}
      {labels}
      label={app.messages.timeline.label}
      {scrollTop}
      {scrollLeft}
      scrolled={followScroll}
      resized={followSize}
      select={selectTask}
    />
  </div>
</main>

<style>
  .workspace {
    flex-grow: 1;
    min-height: 0;
    display: flex;
    background: var(--color-surface);
  }

  .table-pane {
    flex-shrink: 0;
    min-width: 0;
  }

  .separator {
    width: 6px;
    flex-shrink: 0;
    cursor: col-resize;
    background: var(--color-background);
    border-left: 1px solid var(--color-border);
    border-right: 1px solid var(--color-border);
  }

  .separator:hover,
  .separator:focus-visible {
    background: var(--color-panel);
  }

  .timeline-pane {
    flex-grow: 1;
    min-width: 0;
  }
</style>
