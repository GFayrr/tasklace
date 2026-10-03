<script lang="ts">
  import type { TaskId } from '../../core/model/project';
  import type { LinkEnd } from '../plan/task-commands';
  import { createPatternCache } from '../plan/bar-patterns';
  import { buildScaleTicks, type ScaleLabels } from '../plan/time-scale';
  import {
    DRAG_THRESHOLD,
    gestureAt,
    targetBlockAt,
    type DragPreview,
    type GestureKind,
    type GestureTarget,
  } from '../plan/timeline-gestures';
  import { hourAt, ROW_HEIGHT, rowShape, xOf, type RowShape } from '../plan/timeline-geometry';
  import {
    paintTimelineBody,
    paintTimelineHeader,
    type TimelineScene,
    type Viewport,
  } from '../plan/timeline-painter';

  interface Props {
    readonly scene: Omit<TimelineScene, 'patternFor' | 'preview'>;
    readonly labels: ScaleLabels;
    readonly label: string;
    readonly scrollTop: number;
    readonly scrollLeft: number;
    readonly scrolled: (top: number, left: number) => void;
    readonly resized: (width: number, height: number) => void;
    readonly select: (id: TaskId) => void;
    readonly moved: (shape: RowShape, offset: number, block: number | null) => void;
    readonly stretched: (shape: RowShape, offset: number) => void;
    readonly linked: (from: LinkEnd, toRow: number, toBlock: number | null) => void;
    readonly opened: (id: TaskId) => void;
  }

  interface Drag {
    readonly target: GestureTarget;
    readonly startX: number;
    readonly startY: number;
    moved: boolean;
  }

  interface Drawing {
    readonly scene: Omit<TimelineScene, 'patternFor'>;
    readonly viewport: Viewport;
  }

  let {
    scene,
    labels,
    label,
    scrollTop,
    scrollLeft,
    scrolled,
    resized,
    select,
    moved,
    stretched,
    linked,
    opened,
  }: Props = $props();

  const HEADER_HEIGHT = 48;
  const CURSORS: Readonly<Record<GestureKind | 'none', string>> = {
    move: 'grab',
    stretch: 'ew-resize',
    link: 'crosshair',
    none: 'default',
  };
  const EXTRA_ROWS = 3;
  let scroller: HTMLDivElement | undefined = $state();
  let body: HTMLCanvasElement | undefined = $state();
  let header: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  let frameRequest = 0;
  let preview = $state.raw<DragPreview | null>(null);
  let cursor = $state('default');
  let drag: Drag | null = null;
  let next: Drawing | null = null;
  const patternFor = createPatternCache(
    () => document.createElement('canvas'),
    () => body?.getContext('2d') ?? null,
  );
  const contentWidth = $derived(xOf(scene.frame, scene.frame.end));
  const contentHeight = $derived((scene.rows.length + EXTRA_ROWS) * ROW_HEIGHT);

  /** Sizes a canvas for the screen density and returns its drawing context scaled to CSS pixels. */
  function prepare(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
  ): CanvasRenderingContext2D | null {
    const density = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(cssWidth * density));
    const pixelHeight = Math.max(1, Math.round(cssHeight * density));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    context?.setTransform(density, 0, 0, density, 0, 0);
    return context;
  }

  /** Draws the scale and the visible rows as they were last asked. */
  function paint(): void {
    frameRequest = 0;
    const drawing = next;
    if (drawing === null || body === undefined || header === undefined) {
      return;
    }
    const { viewport } = drawing;
    const fullScene: TimelineScene = { ...drawing.scene, patternFor };
    const bodyContext = prepare(body, viewport.width, viewport.height);
    if (bodyContext !== null) {
      paintTimelineBody(bodyContext, fullScene, viewport);
    }
    const headerContext = prepare(header, viewport.width, HEADER_HEIGHT);
    if (headerContext !== null) {
      const ticks = buildScaleTicks(
        fullScene.zoom,
        hourAt(fullScene.frame, viewport.left),
        hourAt(fullScene.frame, viewport.left + viewport.width),
        labels,
      );
      const scale = { ...viewport, top: 0, height: HEADER_HEIGHT };
      paintTimelineHeader(headerContext, fullScene, scale, ticks);
    }
  }

  $effect(() => {
    next = {
      scene: { ...scene, preview },
      viewport: { left: scrollLeft, top: scrollTop, width, height },
    };
    if (frameRequest === 0 && width > 0) {
      frameRequest = requestAnimationFrame(paint);
    }
  });

  $effect(() => {
    const target = scroller;
    target?.addEventListener('pointerdown', pointerDown);
    target?.addEventListener('pointermove', pointerMove);
    target?.addEventListener('pointerup', pointerUp);
    target?.addEventListener('pointercancel', pointerCancel);
    target?.addEventListener('dblclick', openAt);
    return () => {
      target?.removeEventListener('dblclick', openAt);
      target?.removeEventListener('pointerdown', pointerDown);
      target?.removeEventListener('pointermove', pointerMove);
      target?.removeEventListener('pointerup', pointerUp);
      target?.removeEventListener('pointercancel', pointerCancel);
    };
  });

  $effect(() => {
    if (scroller === undefined) {
      return;
    }
    const observed = scroller;
    const observer = new ResizeObserver(() => {
      width = observed.clientWidth;
      height = observed.clientHeight;
      resized(width, height);
    });
    observer.observe(observed);
    return () => {
      observer.disconnect();
    };
  });

  $effect(() => {
    if (scroller !== undefined && Math.abs(scroller.scrollTop - scrollTop) >= 1) {
      scroller.scrollTop = scrollTop;
    }
    if (scroller !== undefined && Math.abs(scroller.scrollLeft - scrollLeft) >= 1) {
      scroller.scrollLeft = scrollLeft;
    }
  });

  /** Follows the scroll of the timeline, which drives both panes. */
  function followScroll(): void {
    if (scroller === undefined) {
      return;
    }
    scrolled(scroller.scrollTop, scroller.scrollLeft);
  }

  /** Returns the position of a pointer in the whole timeline. */
  function contentPoint(event: PointerEvent): { readonly x: number; readonly y: number } | null {
    if (scroller === undefined) {
      return null;
    }
    const bounds = scroller.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left + scrollLeft,
      y: event.clientY - bounds.top + scrollTop,
    };
  }

  /** Returns the shape of the row at a vertical position, or null. */
  function shapeAtY(y: number): RowShape | null {
    const index = Math.floor(y / ROW_HEIGHT);
    const row = scene.rows[index];
    return row === undefined || scene.schedule === null
      ? null
      : rowShape(row, index, scene.schedule, scene.frame);
  }

  /** Returns what the pointer would drag at a position. */
  function targetAt(point: { readonly x: number; readonly y: number }): GestureTarget | null {
    return gestureAt(shapeAtY(point.y), point.x, point.y, scene.selectedTaskId);
  }

  /** Selects the task under the pointer and starts dragging its bar, its end or its link handle. */
  function pointerDown(event: PointerEvent): void {
    const point = contentPoint(event);
    if (point === null || event.button !== 0) {
      return;
    }
    const target = targetAt(point);
    const task = scene.rows[Math.floor(point.y / ROW_HEIGHT)]?.task;
    if (task !== undefined && target?.kind !== 'link') {
      select(task.id);
    }
    if (target !== null && scroller !== undefined) {
      scroller.setPointerCapture(event.pointerId);
      drag = { target, startX: point.x, startY: point.y, moved: false };
    }
  }

  /** Follows a drag with a preview, or shows what the pointer would drag. */
  function pointerMove(event: PointerEvent): void {
    const point = contentPoint(event);
    if (point === null) {
      return;
    }
    if (drag === null) {
      cursor = CURSORS[targetAt(point)?.kind ?? 'none'];
      return;
    }
    const offset = point.x - drag.startX;
    drag.moved ||= Math.hypot(offset, point.y - drag.startY) > DRAG_THRESHOLD;
    if (!drag.moved) {
      return;
    }
    const { target } = drag;
    if (target.kind === 'link') {
      const row = Math.floor(point.y / ROW_HEIGHT);
      const candidate = scene.rows[row]?.task;
      const targetRow =
        candidate === undefined || candidate.kind === 'summary' || candidate.id === target.taskId
          ? null
          : row;
      const targetShape = targetRow === null ? null : shapeAtY(point.y);
      preview = {
        kind: 'link',
        shape: target.shape,
        block: target.block,
        pointer: point,
        targetRow,
        targetBlock: targetShape === null ? null : targetBlockAt(targetShape, point.x),
      };
      return;
    }
    preview =
      target.kind === 'move'
        ? { kind: 'move', shape: target.shape, offset, block: target.block }
        : { kind: 'stretch', shape: target.shape, offset };
  }

  /** Applies a finished drag. */
  function pointerUp(event: PointerEvent): void {
    const finished = drag;
    const shown = preview;
    drag = null;
    preview = null;
    const point = contentPoint(event);
    if (finished === null || !finished.moved || point === null) {
      return;
    }
    const offset = point.x - finished.startX;
    const { target } = finished;
    if (target.kind === 'move') {
      moved(target.shape, offset, target.block);
    } else if (target.kind === 'stretch') {
      stretched(target.shape, offset);
    } else if (shown?.kind === 'link' && shown.targetRow !== null) {
      linked({ taskId: target.taskId, block: target.block }, shown.targetRow, shown.targetBlock);
    }
  }

  /** Opens the details of the task whose bar is double-clicked. */
  function openAt(event: MouseEvent): void {
    if (scroller === undefined) {
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const row = Math.floor((event.clientY - bounds.top + scrollTop) / ROW_HEIGHT);
    const task = scene.rows[row]?.task;
    if (task !== undefined) {
      opened(task.id);
    }
  }

  /** Abandons a drag. */
  function pointerCancel(): void {
    drag = null;
    preview = null;
  }
</script>

<section class="timeline" aria-label={label}>
  <canvas class="header" bind:this={header} style:width="{width}px" aria-hidden="true"></canvas>
  <div class="body">
    <canvas
      class="layer"
      bind:this={body}
      style:width="{width}px"
      style:height="{height}px"
      aria-hidden="true"
    ></canvas>
    <div class="scroller" bind:this={scroller} onscroll={followScroll} style:cursor>
      <div class="spacer" style:width="{contentWidth}px" style:height="{contentHeight}px"></div>
    </div>
  </div>
</section>

<style>
  .timeline {
    height: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
  }

  .header {
    display: block;
    flex-shrink: 0;
    height: 48px;
  }

  .body {
    position: relative;
    flex-grow: 1;
    min-height: 0;
  }

  .layer {
    position: absolute;
    top: 0;
    left: 0;
  }

  .scroller {
    position: absolute;
    inset: 0;
    overflow: auto;
  }

  .spacer {
    pointer-events: none;
  }
</style>
