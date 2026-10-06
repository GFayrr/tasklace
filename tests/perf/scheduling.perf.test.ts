import { describe, expect, it } from 'vitest';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { buildLargeProject } from '../fixtures/large-project';

const TARGET_MILLISECONDS = 100;
const MEASURED_RUNS = 5;

/** Runs a function several times after a warm-up and returns the median duration in milliseconds. */
function medianDuration(run: () => void): number {
  run();
  const durations = Array.from({ length: MEASURED_RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return durations[Math.floor(MEASURED_RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('scheduling performance (10,000 tasks, 20,000 dependencies)', () => {
  const large = buildLargeProject();

  it(`computes the schedule in less than ${String(TARGET_MILLISECONDS)} ms`, () => {
    expect(scheduleProject(large).ok).toBe(true);
    const duration = medianDuration(() => scheduleProject(large));
    console.info(`Schedule: ${duration.toFixed(1)} ms`);
    expect(duration).toBeLessThan(TARGET_MILLISECONDS);
  });

  it('reports the cost of the optional critical path', () => {
    const withCriticalPath = {
      ...large,
      options: {
        criticalPathEnabled: true,
        dateConstraintsEnabled: true,
        baselineEnabled: false,
        alwaysShowPatterns: false,
      },
    };
    expect(scheduleProject(withCriticalPath).ok).toBe(true);
    const duration = medianDuration(() => scheduleProject(withCriticalPath));
    console.info(`Schedule with critical path: ${duration.toFixed(1)} ms`);
    expect(duration).toBeGreaterThan(0);
  });
});
