import { describe, expect, it } from 'vitest';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { buildLargeProject } from '../fixtures/large-project';
import { medianDuration } from '../growth/measure-growth';

const TARGET_MILLISECONDS = 100;
const MEASURED_RUNS = 5;

describe('scheduling performance (10,000 tasks, 20,000 dependencies)', () => {
  const large = buildLargeProject();

  it(`computes the schedule in less than ${String(TARGET_MILLISECONDS)} ms`, () => {
    expect(scheduleProject(large).ok).toBe(true);
    const duration = medianDuration(() => scheduleProject(large), MEASURED_RUNS);
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
    const duration = medianDuration(() => scheduleProject(withCriticalPath), MEASURED_RUNS);
    console.info(`Schedule with critical path: ${duration.toFixed(1)} ms`);
    expect(duration).toBeGreaterThan(0);
  });
});
