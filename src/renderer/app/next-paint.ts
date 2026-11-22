export const MAX_PAINT_WAIT_MILLISECONDS = 64;

/** Resolves once the browser has painted what the page shows now, the task queued from the frame asked for running after that frame is painted, at once for a hidden page and after a short wait at most, since a hidden window gets no frames. */
export function nextPaint(): Promise<void> {
  if (document.visibilityState === 'hidden') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const late = setTimeout(resolve, MAX_PAINT_WAIT_MILLISECONDS);
    requestAnimationFrame(() => {
      clearTimeout(late);
      setTimeout(resolve, 0);
    });
  });
}
