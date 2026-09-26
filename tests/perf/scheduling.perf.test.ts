import { describe, expect, it } from 'vitest';
import type { Dependency, DependencyType, Tag, Task } from '../../src/core/model/project';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { milestone, project, splitTask, workTask } from '../../src/core/testing/project-builder';

const TASK_COUNT = 10_000;
const DEPENDENCY_COUNT = 20_000;
const MAX_LINK_DISTANCE = 50;
const MAX_DURATION_HOURS = 40;
const MILESTONE_RATIO = 0.1;
const SPLIT_TASK_RATIO = 0.05;
const TARGET_MILLISECONDS = 100;
const MEASURED_RUNS = 5;
const RANDOM_SEED = 20_260_928;
const PERSON_COUNT = 20;
const PERSON_TAGS: Tag[] = Array.from({ length: PERSON_COUNT }, (_value, index) => ({
  id: `person${String(index)}`,
  name: `Person ${String(index)}`,
  color: '#2a78d6',
  representsPersonOrTeam: true,
}));
const LINK_TYPES: DependencyType[] = [
  'finishToStart',
  'finishToStart',
  'startToStart',
  'finishToFinish',
];

/** Creates a deterministic 32-bit pseudo-random generator (mulberry32) returning numbers in [0, 1). */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Builds a realistic large project: short tasks, some milestones and split tasks, local links. */
function buildLargeProject(): ReturnType<typeof project> {
  const random = createRandom(RANDOM_SEED);
  const idOf = (index: number): string => `t${String(index)}`;
  const tagOf = (index: number): string => `person${String(index % PERSON_COUNT)}`;
  const tasks: Task[] = Array.from({ length: TASK_COUNT }, (_value, index) => {
    const roll = random();
    const durationHours = 1 + Math.floor(random() * MAX_DURATION_HOURS);
    if (roll < MILESTONE_RATIO) {
      return milestone(idOf(index), { tagId: tagOf(index) });
    }
    if (roll < MILESTONE_RATIO + SPLIT_TASK_RATIO) {
      return splitTask(
        idOf(index),
        [
          [durationHours, 0],
          [durationHours, 7],
        ],
        { tagId: tagOf(index) },
      );
    }
    return workTask(idOf(index), {
      segments: [{ durationHours, gapDaysBefore: 0 }],
      tagId: tagOf(index),
    });
  });
  const dependencies = new Map<string, Dependency>();
  while (dependencies.size < DEPENDENCY_COUNT) {
    const from = Math.floor(random() * (TASK_COUNT - 1));
    const to = Math.min(TASK_COUNT - 1, from + 1 + Math.floor(random() * MAX_LINK_DISTANCE));
    const id = `${idOf(from)}->${idOf(to)}`;
    const type = LINK_TYPES[Math.floor(random() * LINK_TYPES.length)] ?? 'finishToStart';
    dependencies.set(id, {
      id,
      predecessorId: idOf(from),
      successorId: idOf(to),
      type,
      lagHours: 0,
    });
  }
  return project(tasks, [...dependencies.values()], { tags: PERSON_TAGS });
}

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
        alwaysShowPatterns: false,
      },
    };
    expect(scheduleProject(withCriticalPath).ok).toBe(true);
    const duration = medianDuration(() => scheduleProject(withCriticalPath));
    console.info(`Schedule with critical path: ${duration.toFixed(1)} ms`);
    expect(duration).toBeGreaterThan(0);
  });
});
