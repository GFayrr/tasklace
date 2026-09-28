export const SIZE_FACTOR = 4;
export const LINEAR_MAX_RATIO = 8;
export const CONSTANT_MAX_RATIO = 2;
export const SMALL_TASK_COUNT = 2_500;
export const LARGE_TASK_COUNT = SMALL_TASK_COUNT * SIZE_FACTOR;
export const BATCH_SIZE = 50;
export const MEASURED_RUNS = 7;

/** Runs a function once to warm it up, then returns the median of several timed runs in milliseconds. */
export function medianDuration(run: () => void): number {
  run();
  const durations = Array.from({ length: MEASURED_RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return durations[Math.floor(MEASURED_RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

/** Returns how many times longer the same operation takes on the large input than on the small one. */
export function growthRatio(onSmall: () => void, onLarge: () => void): number {
  return medianDuration(onLarge) / medianDuration(onSmall);
}

/** Wraps an operation so that one timed run performs it a number of times, making very short operations measurable. */
export function batched(times: number, operation: (index: number) => void): () => void {
  let next = 0;
  return () => {
    for (let count = 0; count < times; count += 1) {
      operation(next);
      next += 1;
    }
  };
}
