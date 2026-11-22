import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../src/core/compare-strings';
import type { Dependency, Task } from '../../src/core/model/project';
import { valueAt } from '../../src/core/table-value';
import {
  buildPlanOutline,
  groupIncoming,
  nextIncoming,
  nextPlanOutline,
  NOTHING_COLLAPSED,
} from '../../src/renderer/plan/plan-outline';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import { LARGE_TASK_COUNT, medianDuration } from './measure-growth';

const MAX_SHARE_OF_FULL_BUILD = 0.5;
const STEP_RUNS = 21;
const LAG_CHOICES = 5;

/** Builds the large project with its lists sorted by identifier, as the session gives them. */
function sortedProject() {
  const project = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);
  return {
    tasks: [...project.tasks].sort((left, right) => compareStrings(left.id, right.id)),
    dependencies: [...project.dependencies].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
}

/** Returns a copy of a list with one item replaced, as a change of the project gives. */
function replacedAt<Item>(list: readonly Item[], index: number, item: Item): readonly Item[] {
  const next = list.slice();
  next[index] = item;
  return next;
}

describe('cost of following one change of a large plan', () => {
  it('renames a task in the outline for less than half of what building the outline costs', () => {
    let tasks: readonly Task[] = sortedProject().tasks;
    let basis = nextPlanOutline(null, tasks, NOTHING_COLLAPSED);
    const step = medianDuration((index) => {
      const at = index % tasks.length;
      const task = valueAt(tasks, at);
      tasks = replacedAt(tasks, at, { ...task, name: `Renamed ${String(index)}` });
      basis = nextPlanOutline(basis, tasks, NOTHING_COLLAPSED);
    }, STEP_RUNS);
    const full = medianDuration(() => {
      buildPlanOutline(tasks, NOTHING_COLLAPSED);
    }, STEP_RUNS);
    console.info(`Rename in the outline: ${(step / full).toFixed(2)} of a full build`);
    expect(step / full).toBeLessThanOrEqual(MAX_SHARE_OF_FULL_BUILD);
  });

  it('changes the lag of a dependency in the grouping for less than half of what grouping every dependency costs', () => {
    let dependencies: readonly Dependency[] = sortedProject().dependencies;
    let basis = nextIncoming(null, dependencies);
    const step = medianDuration((index) => {
      const at = index % dependencies.length;
      const dependency = valueAt(dependencies, at);
      dependencies = replacedAt(dependencies, at, {
        ...dependency,
        lagHours: (dependency.lagHours + 1) % LAG_CHOICES,
      });
      basis = nextIncoming(basis, dependencies);
    }, STEP_RUNS);
    const full = medianDuration(() => {
      groupIncoming(dependencies);
    }, STEP_RUNS);
    console.info(`Lag in the grouping: ${(step / full).toFixed(2)} of a full grouping`);
    expect(step / full).toBeLessThanOrEqual(MAX_SHARE_OF_FULL_BUILD);
  });
});
