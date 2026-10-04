<script lang="ts">
  import type { TaskId } from '../../core/model/project';
  import type { LinkEnd } from '../plan/task-commands';
  import type { DrawingPart } from '../app/app-state.svelte';
  import { createPatternCache } from '../plan/bar-patterns';
  import { pixels } from './css-length';
  import { buildScaleTicks, type ScaleLabels } from '../plan/time-scale';
  import {
    DRAG_THRESHOLD,
    gestureAt,
    targetBlockAt,
    type DragPreview,
    type BarShape,
    type PlacedShape,
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
    readonly moved: (shape: PlacedShape, offset: number, block: number | null) => void;
    readonly stretched: (shape: BarShape, offset: number) => void;
    readonly linked: (from: LinkEnd, to: LinkEnd) => void;
    readonly opened: (id: TaskId) => void;
    readonly drawingFailed: (part: DrawingPart) => void;
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
    drawingFailed,
  }: Props = $props();

  const HEADER_HEIGHT = 48;
  const CURSORS: Readonly<Record<GestureTarget['kind'] | 'none', string>> = {
    move: 'grab',
    stretch: 'ew-resize',
    link: 'crosshair',
    none: 'default',
  };
  const EXTRA_ROWS = 3;
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
    () => {
      drawingFailed('patterns');
    },
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
    if (context === null) {
      drawingFailed('timeline');
      return null;
    }
    context.setTransform(density, 0, 0, density, 0, 0);
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

  /** Listens to the pointer on the scrolling area to select, drag, stretch and link bars, and to open the details of a task. */
  function followPointer(element: HTMLDivElement): () => void {
    const down = (event: PointerEvent): void => {
      pointerDown(event, element);
    };
    const move = (event: PointerEvent): void => {
      pointerMove(event, element);
    };
    const up = (event: PointerEvent): void => {
      pointerUp(event, element);
    };
    const open = (event: MouseEvent): void => {
      openAt(event, element);
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', pointerCancel);
    element.addEventListener('dblclick', open);
    return () => {
      element.removeEventListener('dblclick', open);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', pointerCancel);
    };
  }

  /** Follows the size of the scrolling area, which is the size of the drawing. */
  function followSize(element: HTMLDivElement): () => void {
    const observer = new ResizeObserver(() => {
      width = element.clientWidth;
      height = element.clientHeight;
      resized(width, height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }

  /** Scrolls the area to the position the workspace asks for, when it differs from where it is. */
  function keepScroll(element: HTMLDivElement): void {
    if (Math.abs(element.scrollTop - scrollTop) >= 1) {
      element.scrollTop = scrollTop;
    }
    if (Math.abs(element.scrollLeft - scrollLeft) >= 1) {
      element.scrollLeft = scrollLeft;
    }
  }

  /** Returns the position of a pointer in the whole timeline. */
  function contentPoint(
    event: MouseEvent,
    element: HTMLElement,
  ): { readonly x: number; readonly y: number } {
    const bounds = element.getBoundingClientRect();
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
  function pointerDown(event: PointerEvent, element: HTMLElement): void {
    if (event.button !== 0) {
      return;
    }
    const point = contentPoint(event, element);
    const target = targetAt(point);
    const task = scene.rows[Math.floor(point.y / ROW_HEIGHT)]?.task;
    if (task !== undefined && target?.kind !== 'link') {
      select(task.id);
    }
    if (target !== null) {
      element.setPointerCapture(event.pointerId);
      drag = { target, startX: point.x, startY: point.y, moved: false };
    }
  }

  /** Follows a drag with a preview, or shows what the pointer would drag. */
  function pointerMove(event: PointerEvent, element: HTMLElement): void {
    const point = contentPoint(event, element);
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
      const linkable =
        candidate !== undefined &&
        candidate.kind !== 'summary' &&
        candidate.id !== target.shape.taskId;
      const targetShape = linkable ? shapeAtY(point.y) : null;
      preview = {
        kind: 'link',
        shape: target.shape,
        block: target.block,
        pointer: point,
        target: linkable
          ? {
              row,
              end: {
                taskId: candidate.id,
                block: targetShape === null ? null : targetBlockAt(targetShape, point.x),
              },
            }
          : null,
      };
      return;
    }
    preview =
      target.kind === 'move'
        ? { kind: 'move', shape: target.shape, offset, block: target.block }
        : { kind: 'stretch', shape: target.shape, offset };
  }

  /** Applies a finished drag. */
  function pointerUp(event: PointerEvent, element: HTMLElement): void {
    const finished = drag;
    const shown = preview;
    drag = null;
    preview = null;
    if (finished?.moved !== true) {
      return;
    }
    const offset = contentPoint(event, element).x - finished.startX;
    const { target } = finished;
    if (target.kind === 'move') {
      moved(target.shape, offset, target.block);
    } else if (target.kind === 'stretch') {
      stretched(target.shape, offset);
    } else if (shown?.kind === 'link' && shown.target !== null) {
      linked({ taskId: target.shape.taskId, block: target.block }, shown.target.end);
    }
  }

  /** Opens the details of the task whose bar is double-clicked. */
  function openAt(event: MouseEvent, element: HTMLElement): void {
    const row = Math.floor(contentPoint(event, element).y / ROW_HEIGHT);
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
  <canvas class="header" bind:this={header} style:width={pixels(width)} aria-hidden="true"></canvas>
  <div class="body">
    <canvas
      class="layer"
      bind:this={body}
      style:width={pixels(width)}
      style:height={pixels(height)}
      aria-hidden="true"
    ></canvas>
    <div
      class="scroller"
      style:cursor
      {@attach followPointer}
      {@attach followSize}
      {@attach keepScroll}
      onscroll={(event) => {
        scrolled(event.currentTarget.scrollTop, event.currentTarget.scrollLeft);
      }}
    >
      <div
        class="spacer"
        style:width={pixels(contentWidth)}
        style:height={pixels(contentHeight)}
      ></div>
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
