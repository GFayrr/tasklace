<script lang="ts">
  import { untrack } from 'svelte';
  import { failure } from '../../core/result';
  import type { Project, TaskId } from '../../core/model/project';
  import type { AppState, DrawingPart } from '../app/app-state.svelte';
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
  import {
    linkTasks,
    moveOnTimeline,
    stretchOnTimeline,
    type LinkEnd,
  } from '../plan/task-commands';
  import {
    movedStart,
    stretchedEnd,
    type BarShape,
    type PlacedShape,
  } from '../plan/timeline-gestures';
  import { baselineMarks, ROW_HEIGHT, timelineFrame, xOf } from '../plan/timeline-geometry';
  import { tagStylesOf } from '../plan/tag-styles';
  import { localHourOf } from '../project/new-project';
  import { pixels } from './css-length';
  import TaskTable from './TaskTable.svelte';
  import Timeline from './Timeline.svelte';

  let { app, project }: { app: AppState; project: Project } = $props();

  const TODAY_REFRESH_MS = 60_000;
  const LEAD_DAYS_SHOWN = 2;
  const HOURS_PER_DAY = 24;
  const storage = (() => {
    try {
      return window.localStorage;
    } catch (error) {
      console.warn('The width of the table will not be remembered:', error);
      return null;
    }
  })();

  let tableWidth = $state(readTableWidth(storage));
  let containerWidth = $state(0);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let timelineWidth = 0;
  let today = $state(localHourOf(new Date()));

  const outline = $derived(app.outline);
  const calendar = $derived(app.calendar);
  const tagStyles = $derived(tagStylesOf(project));
  const conflictTaskIds = $derived(
    new Set([
      ...(app.schedule?.tagConflicts.conflicts.flatMap((conflict) => conflict.taskIds) ?? []),
      ...app.dateConflictLines.map((line) => line.conflict.taskId),
    ]),
  );
  const baseline = $derived(app.shownBaseline);
  const deadlines = $derived(
    project.options.dateConstraintsEnabled
      ? {
          missedTaskIds: new Set(
            app.dateConflictLines
              .filter((line) => line.conflict.code === 'DEADLINE_MISSED')
              .map((line) => line.conflict.taskId),
          ),
        }
      : null,
  );
  const frame = $derived(
    timelineFrame(project.startDate, app.schedule, today, pixelsPerHour(app.zoom), [
      ...app.shownDeadlines,
      ...baselineMarks(project.options.baselineEnabled ? project.baseline : null, (id) =>
        outline.wbsById.has(id),
      ),
    ]),
  );
  let scrollLeft = $state(untrack(() => startScrollLeft()));
  const formatters = $derived(createTableFormatters(app.locale));
  const labels = $derived(createScaleLabels(app.locale));
  const shownWidth = $derived(clampTableWidth(tableWidth, containerWidth));
  const scene = $derived({
    frame,
    zoom: app.zoom,
    rows: outline.rows,
    rowIndexById: outline.rowIndexById,
    schedule: app.schedule,
    dependencies: project.dependencies,
    calendar,
    nonWorkingPeriods: project.calendar.nonWorkingPeriods,
    theme: app.theme,
    tagStyles,
    conflictTaskIds,
    deadlines,
    baseline,
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

  /** Returns the scroll that shows the project from a little before its start, where a newly opened project is shown. */
  function startScrollLeft(): number {
    return Math.max(0, xOf(frame, project.startDate - LEAD_DAYS_SHOWN * HOURS_PER_DAY));
  }

  $effect(() => {
    const request = app.revealRequest === null ? null : app.takeRevealRequest();
    if (request === null) {
      return;
    }
    const row = untrack(() => outline.rowIndexById.get(request.taskId));
    if (row !== undefined) {
      reveal(row);
    }
    scrollLeft = Math.max(
      0,
      untrack(() => xOf(frame, request.hour - LEAD_DAYS_SHOWN * HOURS_PER_DAY)),
    );
  });

  /** Opens the details of a task. */
  function openDetails(id: TaskId): void {
    app.openDetails(id);
  }

  /** Selects a task. */
  function selectTask(id: TaskId): void {
    app.select(id);
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

  /** Asks a dragged bar, or a later block of it, to start where it was dropped, aligned to the quarter hour or the day. */
  function moveBar(shape: PlacedShape, offset: number, block: number | null): void {
    const current = app.currentSchedule;
    const snap = snapHours(app.zoom);
    app.edit((context) =>
      current.ok
        ? moveOnTimeline(
            context,
            shape.taskId,
            block,
            current.value?.placements.get(shape.taskId),
            (from) => movedStart(frame, from, offset, snap),
          )
        : current,
    );
  }

  /** Changes the duration of a stretched bar so that it ends where it was dropped. */
  function stretchBar(shape: BarShape, offset: number): void {
    const current = app.currentSchedule;
    const calendar = app.calendar;
    const snap = snapHours(app.zoom);
    app.edit((context) =>
      current.ok
        ? stretchOnTimeline(
            context,
            shape.taskId,
            { placement: current.value?.placements.get(shape.taskId), calendar },
            (end) => stretchedEnd(frame, end, offset, snap),
          )
        : current,
    );
  }

  /** Links a task, or one of its blocks, to the task or block a link was dropped on. */
  function linkBar(from: LinkEnd, to: LinkEnd): void {
    app.edit((context) => linkTasks(context, from, to));
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
    /** Resizes the task table as the pointer moves. */
    const move = (moved: PointerEvent): void => {
      setTableWidth(startWidth + moved.clientX - startX);
    };
    /** Stops resizing the task table. */
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
  <div class="table-pane" style:width={pixels(shownWidth)}>
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
      linkedToSummary={() => {
        app.edit(() => failure('SUMMARY_DEPENDENCY'));
      }}
      opened={openDetails}
      drawingFailed={(part: DrawingPart) => {
        app.reportDrawingProblem(part);
      }}
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
