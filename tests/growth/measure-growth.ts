export const SIZE_FACTOR = 4;
export const LINEAR_MAX_RATIO = 8;
export const CONSTANT_MAX_RATIO = 2;
export const SMALL_TASK_COUNT = 2_500;
export const LARGE_TASK_COUNT = SMALL_TASK_COUNT * SIZE_FACTOR;
export const BATCH_SIZE = 50;
export const MEASURED_RUNS = 7;

/** Runs a function once to warm it up, then returns the median of several timed runs in milliseconds, each run receiving its index and the warm-up the number of runs, so that each run can work on its own copy. */
export function medianDuration(run: (index: number) => void, runs: number = MEASURED_RUNS): number {
  run(runs);
  const durations = Array.from({ length: runs }, (_unused, index) => {
    const start = performance.now();
    run(index);
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return durations[Math.floor(runs / 2)] ?? Number.POSITIVE_INFINITY;
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

/** Runs an asynchronous operation once to warm it up, then returns the median of several timed runs in milliseconds, each run receiving its index and the warm-up the number of runs. */
export async function medianDurationOf(
  run: (index: number) => Promise<void>,
  runs: number = MEASURED_RUNS,
): Promise<number> {
  await run(runs);
  const durations: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run(index);
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.floor(runs / 2)] ?? Number.POSITIVE_INFINITY;
}

/** Returns how many times longer the same asynchronous operation takes on the large input than on the small one. */
export async function growthRatioOf(
  onSmall: (index: number) => Promise<void>,
  onLarge: (index: number) => Promise<void>,
): Promise<number> {
  return (await medianDurationOf(onLarge)) / (await medianDurationOf(onSmall));
}
