import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../src/core/compare-strings';
import type { Project } from '../../src/core/model/project';
import { valueAt } from '../../src/core/table-value';
import {
  applyScheduleDelta,
  projectDeltaOf,
  scheduleTableOf,
} from '../../src/renderer/schedule/schedule-changes';
import { createScheduleHost } from '../../src/renderer/schedule/schedule-host';
import {
  SCHEDULE_PROTOCOL_VERSION,
  type ScheduleResponse,
} from '../../src/renderer/schedule/schedule-protocol';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  batched,
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

const RENAMES_PER_RUN = 32;

/** Asks a new host for the whole schedule of a project, copying both messages as the browser does. */
function wholeRoundTrip(project: Project) {
  return () => {
    const request = { version: SCHEDULE_PROTOCOL_VERSION, generation: 1, kind: 'whole', project };
    const response = structuredClone(createScheduleHost().answer(structuredClone(request)));
    expect(response.result.ok).toBe(true);
  };
}

/** Returns a project whose lists are sorted by identifier, as the session of the page gives them. */
function sortedLike(generated: Project): Project {
  /** Sorts items by identifier. */
  const byId = <Item extends { readonly id: string }>(items: readonly Item[]) =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...generated,
    tasks: byId(generated.tasks),
    dependencies: byId(generated.dependencies),
    tags: byId(generated.tags),
  };
}

/** Prepares, for a project, the page side of renames: the request the page copies, the answer of the worker it copies back and the schedule table it changes. */
function renamesOf(generated: Project) {
  const project = sortedLike(generated);
  const host = createScheduleHost();
  const first = host.answer({
    version: SCHEDULE_PROTOCOL_VERSION,
    generation: 1,
    kind: 'whole',
    project,
  });
  if (!first.result.ok || first.result.value.kind !== 'whole') {
    throw new Error('The first schedule was not whole.');
  }
  const table = scheduleTableOf(first.result.value.schedule);
  const steps = Array.from({ length: RENAMES_PER_RUN }, (_unused, index) => {
    const task = valueAt(project.tasks, index);
    const renamed = {
      ...project,
      tasks: project.tasks.with(index, { ...task, name: `Renamed ${String(index)}` }),
    };
    const request = {
      version: SCHEDULE_PROTOCOL_VERSION,
      generation: 2,
      kind: 'changes',
      basis: 1,
      changes: projectDeltaOf(project, renamed),
    } as const;
    const worker = createScheduleHost();
    worker.answer({ version: SCHEDULE_PROTOCOL_VERSION, generation: 1, kind: 'whole', project });
    return { request, response: worker.answer(request) };
  });
  return { table, steps };
}

/** Copies the request and the answer of a rename as the browser does, then changes the schedule table of the page. */
function pageSide(prepared: ReturnType<typeof renamesOf>) {
  return (index: number) => {
    const step = valueAt(prepared.steps, index % prepared.steps.length);
    structuredClone(step.request);
    const response: ScheduleResponse = structuredClone(step.response);
    if (!response.result.ok || response.result.value.kind !== 'changes') {
      throw new Error('A rename was not answered with changes.');
    }
    applyScheduleDelta(prepared.table, response.result.value.changes);
  };
}

describe('growth of the schedule worker round trip', () => {
  const small = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const large = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  it('copies, schedules and copies back a whole project in linear time', () => {
    const ratio = growthRatio(wholeRoundTrip(small), wholeRoundTrip(large));
    console.info(`Schedule worker whole round trip: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('copies a rename to the worker and its answer back, and changes the schedule of the page, in a time that does not depend on the size of the project', () => {
    const ratio = growthRatio(
      batched(RENAMES_PER_RUN, pageSide(renamesOf(small))),
      batched(RENAMES_PER_RUN, pageSide(renamesOf(large))),
    );
    console.info(`Page side of a rename: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});
