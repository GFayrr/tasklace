import { flushSync } from 'svelte';
import { afterEach, beforeEach, vi } from 'vitest';
import { recordingCanvas, type CanvasCall } from '../../plan/testing/recording-canvas';

interface ObservedElement {
  readonly element: Element;
  readonly callback: ResizeObserverCallback;
}

const observed: ObservedElement[] = [];
const frames: FrameRequestCallback[] = [];
let calls: CanvasCall[] = [];
let read = 0;
let withContext = true;

/** Watches sizes only when a test says an element was resized, since the test page has no layout. */
class ManualResizeObserver {
  readonly #callback: ResizeObserverCallback;

  /** Keeps the function to call when a watched element is resized. */
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  /** Starts watching an element. */
  observe(element: Element): void {
    observed.push({ element, callback: this.#callback });
  }

  /** Stops watching one element. */
  unobserve(element: Element): void {
    const index = observed.findIndex(
      (each) => each.element === element && each.callback === this.#callback,
    );
    if (index >= 0) {
      observed.splice(index, 1);
    }
  }

  /** Stops watching every element of this observer. */
  disconnect(): void {
    for (let index = observed.length - 1; index >= 0; index -= 1) {
      if (observed[index]?.callback === this.#callback) {
        observed.splice(index, 1);
      }
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ManualResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const canvas = recordingCanvas();
  calls = canvas.calls;
  read = 0;
  withContext = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
    withContext ? canvas.context : null,
  );
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  observed.length = 0;
  frames.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Makes every canvas refuse to give a drawing context from now on, as a browser out of resources would. */
export function refuseDrawingContexts(): void {
  withContext = false;
}

/** Gives an element a size, as the layout of a real page would, and tells its observers. */
export function resize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
  const entry = {
    target: element,
    contentRect: { width, height },
  } as unknown as ResizeObserverEntry;
  for (const watch of observed.filter((each) => each.element === element)) {
    watch.callback([entry], {} as ResizeObserver);
  }
  flushSync();
}

/** Draws the frames asked so far, returning the drawing calls made since the previous time. */
export function drawFrames(): CanvasCall[] {
  for (const frame of frames.splice(0)) {
    frame(0);
  }
  const made = calls.slice(read);
  read = calls.length;
  return made;
}

/** Sends a pointer event at a position of the page to an element and applies the updates it causes. */
export function pointer(
  element: HTMLElement,
  type: string,
  x: number,
  y: number,
  button = 0,
): void {
  element.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 1, bubbles: true }),
  );
  flushSync();
}
