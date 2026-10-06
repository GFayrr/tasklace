import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import {
  lastWorkingHourEnd,
  shiftWorkingHours,
  subtractWorkingHours,
} from '../calendar/working-time';
import type { Project, SchedulableTask, WorkTask } from '../model/project';
import {
  instantArbitrary,
  permutationOf,
  PROPERTY_TEST_TIMEOUT_MS,
  unwrap,
} from '../testing/arbitraries';
import {
  interleavedProjectArbitrary,
  projectArbitrary,
  type GeneratedProject,
} from '../testing/project-arbitrary';
import type { ProjectHour } from '../time';
import { blockTasksOf } from './dependency-graph';
import { blockResumption } from './block-links';
import { constrainsSuccessorStart, dependencyAnchor } from './forward-pass';
import { scheduleProject, type Schedule } from './schedule-project';
import { placeTask, type Placement } from './task-placement';

/** Compiles the calendar of a generated project, which is always valid. */
function compiledCalendarOf(input: Project): CompiledCalendar {
  return unwrap(compileCalendar(input.calendar));
}

/** Schedules a generated project, failing the property when scheduling fails. */
function scheduleGenerated(input: Project): Schedule {
  const result = scheduleProject(input);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

/** Returns the placement of a task, failing the property when it is missing. */
function placementOf(schedule: Schedule, taskId: string): Placement {
  const placement = schedule.placements.get(taskId);
  if (placement === undefined) {
    throw new Error(`Missing placement for ${taskId}`);
  }
  return placement;
}

interface ScheduledBlock {
  readonly task: SchedulableTask;
  readonly block: number;
  readonly span: Placement;
}

/** Lists every block of every schedulable task with where it was placed, a milestone being one block. */
function scheduledBlocks(input: Project, schedule: Schedule): ScheduledBlock[] {
  return schedulableTasks(input).flatMap((task) => {
    const placement = placementOf(schedule, task.id);
    if (task.kind === 'milestone' || placement.segments.length === 0) {
      return [{ task, block: 0, span: placement }];
    }
    return placement.segments.map((segment, block) => ({
      task,
      block,
      span: { ...segment, segments: [segment] },
    }));
  });
}

/** Returns the block of a task a dependency acts on: the block it names, or the first block for its start and the last for its end. */
function actedBlock(
  schedule: Schedule,
  taskId: string,
  block: number | null,
  onStart: boolean,
): Placement {
  const placement = placementOf(schedule, taskId);
  const blocks = placement.segments;
  const chosen = block === null ? (onStart ? blocks[0] : blocks.at(-1)) : blocks[block];
  return chosen === undefined ? placement : { ...chosen, segments: [chosen] };
}

/** Recomputes, independently from the scheduler, the bounds a block must respect: the project start, the start date of its task for its first block, the resumption after the previous block and its own start date for the others, and the dependencies acting on it. */
function expectedBounds(
  input: Project,
  calendar: CompiledCalendar,
  schedule: Schedule,
  { task, block }: ScheduledBlock,
): { readonly start: ProjectHour; readonly end: ProjectHour | null } {
  let start = Math.max(input.startDate, block === 0 ? (task.startNoEarlierThan ?? 0) : 0);
  const previous = placementOf(schedule, task.id).segments[block - 1];
  if (task.kind === 'task' && previous !== undefined) {
    const segment = task.segments[block] ?? { gapDaysBefore: 0, startNoEarlierThan: null };
    start = Math.max(start, blockResumption(previous.end, segment));
  }
  let end: ProjectHour | null = null;
  const lastBlock = task.kind === 'task' ? task.segments.length - 1 : 0;
  for (const dependency of input.dependencies.filter((link) => link.successorId === task.id)) {
    const onStart = constrainsSuccessorStart(dependency);
    if ((dependency.successorBlock ?? (onStart ? 0 : lastBlock)) !== block) {
      continue;
    }
    const fromStart = dependency.type === 'startToStart' || dependency.type === 'startToFinish';
    const predecessor = actedBlock(
      schedule,
      dependency.predecessorId,
      dependency.predecessorBlock,
      fromStart,
    );
    const bound = unwrap(
      shiftWorkingHours(calendar, dependencyAnchor(dependency, predecessor), dependency.lagHours),
    );
    if (onStart) {
      start = Math.max(start, bound);
    } else {
      end = Math.max(end ?? 0, unwrap(lastWorkingHourEnd(calendar, bound)));
    }
  }
  return { start, end };
}

/** Lists the schedulable tasks of a project. */
function schedulableTasks(input: Project): SchedulableTask[] {
  return input.tasks.filter((task): task is SchedulableTask => task.kind !== 'summary');
}

/** Generates projects of an arbitrary together with the same project in another order of its tasks and dependencies. */
function reorderedOf(arbitrary: fc.Arbitrary<GeneratedProject>) {
  return arbitrary.chain(({ project: input }) =>
    fc.record({
      input: fc.constant(input),
      reordered: fc
        .record({
          tasks: permutationOf(input.tasks),
          dependencies: permutationOf(input.dependencies),
        })
        .map((lists) => ({ ...input, ...lists })),
    }),
  );
}

describe.each([
  ['generated projects', projectArbitrary],
  ['a task between two blocks', interleavedProjectArbitrary],
])('scheduling properties on %s', { timeout: PROPERTY_TEST_TIMEOUT_MS }, (_label, arbitrary) => {
  it('respects every dependency, the project start and every start date, block by block', () => {
    fc.assert(
      fc.property(arbitrary, (generated) => {
        const calendar = compiledCalendarOf(generated.project);
        const schedule = scheduleGenerated(generated.project);
        for (const scheduled of scheduledBlocks(generated.project, schedule)) {
          const bounds = expectedBounds(generated.project, calendar, schedule, scheduled);
          expect(scheduled.span.start).toBeGreaterThanOrEqual(bounds.start);
          expect(scheduled.span.end).toBeGreaterThanOrEqual(bounds.end ?? scheduled.span.end);
        }
      }),
    );
  });

  it('places every block as early as its bounds allow', () => {
    fc.assert(
      fc.property(arbitrary, (generated) => {
        const calendar = compiledCalendarOf(generated.project);
        const schedule = scheduleGenerated(generated.project);
        for (const scheduled of scheduledBlocks(generated.project, schedule)) {
          const bounds = expectedBounds(generated.project, calendar, schedule, scheduled);
          const { task, block, span } = scheduled;
          if (task.kind === 'milestone') {
            expect(span.start).toBe(Math.max(bounds.start, bounds.end ?? bounds.start));
            continue;
          }
          const previousHour = unwrap(subtractWorkingHours(calendar, span.start, 1));
          const earlier = unwrap(
            placeTask(calendar, blockTasksOf(task)[block] ?? task, previousHour),
          );
          const violatesStart = earlier.start < bounds.start;
          const violatesEnd = bounds.end !== null && earlier.end < bounds.end;
          expect(violatesStart || violatesEnd).toBe(true);
        }
      }),
    );
  });

  it('spans every summary exactly over its descendants', () => {
    fc.assert(
      fc.property(arbitrary, ({ project: input }) => {
        const schedule = scheduleGenerated(input);
        const leaves = schedulableTasks(input);
        const descendantsOf = (summaryId: string): SchedulableTask[] =>
          leaves.filter(
            (leaf) => leaf.parentId === summaryId || (summaryId === 's0' && leaf.parentId === 's1'),
          );
        for (const summaryId of ['s0', 's1', 's2']) {
          const placements = descendantsOf(summaryId).map((leaf) => placementOf(schedule, leaf.id));
          const expectedStart =
            placements.length === 0 ? null : Math.min(...placements.map((p) => p.start));
          const expectedEnd =
            placements.length === 0 ? null : Math.max(...placements.map((p) => p.end));
          expect(schedule.summaries.get(summaryId)?.start).toBe(expectedStart);
          expect(schedule.summaries.get(summaryId)?.end).toBe(expectedEnd);
        }
      }),
    );
  });

  it('gives consistent, non-negative floats and at least one critical task', () => {
    fc.assert(
      fc.property(arbitrary, ({ project: input }) => {
        const schedule = scheduleGenerated(input);
        const floats = [...(schedule.floats?.values() ?? [])];
        expect(floats).toHaveLength(schedulableTasks(input).length);
        for (const taskFloat of floats) {
          const total = taskFloat.totalFloatHours ?? Number.NaN;
          expect(total).toBeGreaterThanOrEqual(0);
          expect(taskFloat.freeFloatHours).toBeGreaterThanOrEqual(0);
          expect(taskFloat.freeFloatHours).toBeLessThanOrEqual(total);
        }
        expect(floats.some((taskFloat) => taskFloat.isCritical)).toBe(true);
      }),
    );
  });

  it('computes the same schedule whatever the order of tasks and dependencies', () => {
    fc.assert(
      fc.property(reorderedOf(arbitrary), ({ input, reordered }) => {
        const original = scheduleGenerated(input);
        const shuffled = scheduleGenerated(reordered);
        expect(new Map([...shuffled.placements].sort())).toEqual(
          new Map([...original.placements].sort()),
        );
        expect(new Map([...(shuffled.floats ?? [])].sort())).toEqual(
          new Map([...(original.floats ?? [])].sort()),
        );
        expect(new Map([...shuffled.wbsNumbers].sort())).toEqual(
          new Map([...original.wbsNumbers].sort()),
        );
      }),
    );
  });
});

describe('scheduling properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('never ends a task earlier when it starts later', () => {
    fc.assert(
      fc.property(
        projectArbitrary,
        instantArbitrary,
        fc.integer({ min: 0, max: 500 }),
        ({ project: input }, start, delay) => {
          const calendar = compiledCalendarOf(input);
          const task = schedulableTasks(input).find(
            (candidate): candidate is WorkTask => candidate.kind === 'task',
          );
          if (task === undefined) {
            return;
          }
          const early = unwrap(placeTask(calendar, task, start));
          const late = unwrap(placeTask(calendar, task, start + delay));
          expect(late.start).toBeGreaterThanOrEqual(early.start);
          expect(late.end).toBeGreaterThanOrEqual(early.end);
        },
      ),
    );
  });
});
