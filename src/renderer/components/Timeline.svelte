<script lang="ts">
  import type { TaskId } from '../../core/model/project';
  import { createPatternCache } from '../plan/bar-patterns';
  import { buildScaleTicks, type ScaleLabels } from '../plan/time-scale';
  import { hourAt, ROW_HEIGHT, xOf } from '../plan/timeline-geometry';
  import {
    paintTimelineBody,
    paintTimelineHeader,
    type TimelineScene,
    type Viewport,
  } from '../plan/timeline-painter';

  interface Props {
    readonly scene: Omit<TimelineScene, 'patternFor'>;
    readonly labels: ScaleLabels;
    readonly label: string;
    readonly scrollTop: number;
    readonly scrollLeft: number;
    readonly scrolled: (top: number, left: number) => void;
    readonly resized: (width: number, height: number) => void;
    readonly select: (id: TaskId) => void;
  }

  interface Drawing {
    readonly scene: Omit<TimelineScene, 'patternFor'>;
    readonly viewport: Viewport;
  }

  let { scene, labels, label, scrollTop, scrollLeft, scrolled, resized, select }: Props = $props();

  const HEADER_HEIGHT = 48;
  const EXTRA_ROWS = 3;
  let scroller: HTMLDivElement | undefined = $state();
  let body: HTMLCanvasElement | undefined = $state();
  let header: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  let frameRequest = 0;
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
    next = { scene, viewport: { left: scrollLeft, top: scrollTop, width, height } };
    if (frameRequest === 0 && width > 0) {
      frameRequest = requestAnimationFrame(paint);
    }
  });

  $effect(() => {
    const target = scroller;
    target?.addEventListener('pointerdown', selectAt);
    return () => {
      target?.removeEventListener('pointerdown', selectAt);
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

  /** Selects the task of the row under the pointer. */
  function selectAt(event: PointerEvent): void {
    if (scroller === undefined) {
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const row = Math.floor((event.clientY - bounds.top + scrollTop) / ROW_HEIGHT);
    const task = scene.rows[row]?.task;
    if (task !== undefined) {
      select(task.id);
    }
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
    <div class="scroller" bind:this={scroller} onscroll={followScroll}>
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
