<script lang="ts">
  import { untrack } from 'svelte';
  import type { TaskId } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
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
    snapHours,
    zoomedScrollLeft,
    type ZoomLevel,
  } from '../plan/time-scale';
  import { linkTasks, moveStart, stretchEnd } from '../plan/task-commands';
  import { movedStart, stretchedEnd } from '../plan/timeline-gestures';
  import { ROW_HEIGHT, timelineFrame, xOf, type RowShape } from '../plan/timeline-geometry';
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

  let tableWidth = $state(readTableWidth(storage));
  let containerWidth = $state(0);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportHeight = $state(0);
  let timelineWidth = 0;
  let today = $state(localHourOf(new Date()));

  const project = $derived(app.project);
  const outline = $derived(app.outline);
  const calendar = $derived(app.calendar);
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

  /** Selects a task. */
  function selectTask(id: TaskId): void {
    app.selectedTaskId = id;
  }

  /** Scrolls the least needed to show a row. */
  function reveal(row: number): void {
    const top = row * ROW_HEIGHT;
    if (top < scrollTop) {
      scrollTop = top;
    } else if (top + ROW_HEIGHT > scrollTop + viewportHeight) {
      scrollTop = top + ROW_HEIGHT - viewportHeight;
    }
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

  /** Asks a dragged bar to start where it was dropped, aligned to the hour or the day. */
  function moveBar(shape: RowShape, offset: number): void {
    const placement = app.schedule?.placements.get(shape.taskId);
    if (placement !== undefined) {
      const start = movedStart(frame, placement.start, offset, snapHours(app.zoom));
      app.edit((context) => moveStart(context, shape.taskId, start));
    }
  }

  /** Changes the duration of a stretched bar so that it ends where it was dropped. */
  function stretchBar(shape: RowShape, offset: number): void {
    const placement = app.schedule?.placements.get(shape.taskId);
    const lastBlock = placement?.segments.at(-1);
    const compiled = app.calendar;
    if (placement !== undefined && lastBlock !== undefined && compiled !== null) {
      const end = stretchedEnd(frame, placement.end, offset, snapHours(app.zoom));
      app.edit((context) => stretchEnd(context, shape.taskId, lastBlock.start, end, compiled));
    }
  }

  /** Links a task to the task of the row a link was dropped on. */
  function linkBar(fromId: TaskId, toRow: number): void {
    const target = outline.rows[toRow]?.task;
    if (target !== undefined) {
      app.edit((context) => linkTasks(context, fromId, target.id));
    }
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
    <TaskTable {app} {formatters} {scrollTop} {viewportHeight} scrollBy={scrollRowsBy} {reveal} />
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
      moved={moveBar}
      stretched={stretchBar}
      linked={linkBar}
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
