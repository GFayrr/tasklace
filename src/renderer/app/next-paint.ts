/** Resolves once the browser has painted what the page shows now: a frame is asked for, and the task queued from it runs after that frame is painted. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}
