import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import {
  lastWorkingHourEnd,
  shiftWorkingHours,
  subtractWorkingHours,
} from '../calendar/working-time';
import type { Project, SchedulableTask, WorkTask } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS, instantArbitrary, unwrap } from '../testing/arbitraries';
import { projectArbitrary } from '../testing/project-arbitrary';
import type { ProjectHour } from '../time';
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

/** Recomputes, independently from the scheduler, the bounds a task must respect. */
function expectedBounds(
  input: Project,
  calendar: CompiledCalendar,
  schedule: Schedule,
  task: SchedulableTask,
): { readonly start: ProjectHour; readonly end: ProjectHour | null } {
  let start = Math.max(input.startDate, task.startNoEarlierThan ?? input.startDate);
  let end: ProjectHour | null = null;
  for (const dependency of input.dependencies.filter((link) => link.successorId === task.id)) {
    const anchor = dependencyAnchor(dependency, placementOf(schedule, dependency.predecessorId));
    const bound = unwrap(shiftWorkingHours(calendar, anchor, dependency.lagHours));
    if (constrainsSuccessorStart(dependency)) {
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

describe('scheduling properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('respects every dependency, the project start and every start date', () => {
    fc.assert(
      fc.property(projectArbitrary, (generated) => {
        const calendar = compiledCalendarOf(generated.project);
        const schedule = scheduleGenerated(generated.project);
        for (const task of schedulableTasks(generated.project)) {
          const bounds = expectedBounds(generated.project, calendar, schedule, task);
          const placement = placementOf(schedule, task.id);
          expect(placement.start).toBeGreaterThanOrEqual(bounds.start);
          expect(placement.end).toBeGreaterThanOrEqual(bounds.end ?? placement.end);
        }
      }),
    );
  });

  it('places every task as early as its bounds allow', () => {
    fc.assert(
      fc.property(projectArbitrary, (generated) => {
        const calendar = compiledCalendarOf(generated.project);
        const schedule = scheduleGenerated(generated.project);
        for (const task of schedulableTasks(generated.project)) {
          const bounds = expectedBounds(generated.project, calendar, schedule, task);
          const placement = placementOf(schedule, task.id);
          if (task.kind === 'milestone') {
            expect(placement.start).toBe(Math.max(bounds.start, bounds.end ?? bounds.start));
            continue;
          }
          const previousHour = unwrap(subtractWorkingHours(calendar, placement.start, 1));
          const earlier = unwrap(placeTask(calendar, task, previousHour));
          const violatesStart = earlier.start < bounds.start;
          const violatesEnd = bounds.end !== null && earlier.end < bounds.end;
          expect(violatesStart || violatesEnd).toBe(true);
        }
      }),
    );
  });

  it('spans every summary exactly over its descendants', () => {
    fc.assert(
      fc.property(projectArbitrary, ({ project: input }) => {
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
      fc.property(projectArbitrary, ({ project: input }) => {
        const schedule = scheduleGenerated(input);
        const floats = [...(schedule.floats?.values() ?? [])];
        expect(floats).toHaveLength(schedulableTasks(input).length);
        for (const taskFloat of floats) {
          expect(taskFloat.totalFloatHours).toBeGreaterThanOrEqual(0);
          expect(taskFloat.freeFloatHours).toBeGreaterThanOrEqual(0);
          expect(taskFloat.freeFloatHours).toBeLessThanOrEqual(taskFloat.totalFloatHours);
        }
        expect(floats.some((taskFloat) => taskFloat.isCritical)).toBe(true);
      }),
    );
  });

  it('computes the same schedule whatever the order of tasks and dependencies', () => {
    fc.assert(
      fc.property(projectArbitrary, fc.nat(), ({ project: input }, seed) => {
        const shuffle = <T>(items: readonly T[]): T[] =>
          items
            .map((item, index) => ({ item, key: (index * 7919 + seed) % 104_729 }))
            .sort((left, right) => left.key - right.key)
            .map(({ item }) => item);
        const reordered = {
          ...input,
          tasks: shuffle(input.tasks),
          dependencies: shuffle(input.dependencies),
        };
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
