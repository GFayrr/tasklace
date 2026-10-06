import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileCalendar } from '../calendar/compile-calendar';
import { computeTaskSlots } from '../calendar/task-slots';
import { countWorkingHours, lastWorkingHourEnd, shiftWorkingHours } from '../calendar/working-time';
import type { Project, Task, TaskSegment } from '../model/project';
import { permutationOf, PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { richProjectArbitrary } from '../testing/project-arbitrary';
import { link, project, workTask } from '../testing/project-builder';
import { constrainsSuccessorStart, dependencyAnchor } from './forward-pass';
import { scheduleProject, type Schedule, type SchedulingFailure } from './schedule-project';
import { computePlacementSlots, type Placement } from './task-placement';

/** Schedules a generated project, leaving out the rare project whose early dates leave the supported years (a refusal with its own deterministic tests), and failing the property on any other refusal. */
function scheduled(project: Project): Schedule {
  const result = scheduleProject(project);
  if (!result.ok) {
    fc.pre(!isBeyondHorizon(result.error));
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

/** Tells whether a scheduling failure comes from dates outside the supported years. */
function isBeyondHorizon(failure: SchedulingFailure): boolean {
  return failure.kind === 'task' && failure.error.code === 'BEYOND_PLANNING_HORIZON';
}

/** Returns the placement of a task, failing the property when it is missing. */
function placementOf(schedule: Schedule, id: string): Placement {
  const placement = schedule.placements.get(id);
  if (placement === undefined) {
    throw new Error(`No placement for ${id}`);
  }
  return placement;
}

/** Returns the part of a task a link acts on: a milestone whole, the block a link names, or the first block for a start and the last for an end, failing the property when that block is missing. */
function actedPart(placement: Placement, block: number | null, onStart: boolean): Placement {
  const blocks = placement.segments;
  if (blocks.length === 0) {
    return placement;
  }
  const index = block ?? (onStart ? 0 : blocks.length - 1);
  const chosen = blocks[index];
  if (chosen === undefined) {
    throw new Error(`No block ${String(index)} in the placement`);
  }
  return { ...chosen, segments: [chosen] };
}

/** Returns a block of a task, failing the property when it is missing. */
function segmentOf(task: Extract<Task, { kind: 'task' }>, index: number): TaskSegment {
  const segment = task.segments[index];
  if (segment === undefined) {
    throw new Error(`No block ${String(index)} in task ${task.id}`);
  }
  return segment;
}

/** Returns the tasks and milestones under a summary, at any depth. */
function leavesOf(project: Project, id: string): Task[] {
  return project.tasks
    .filter((task) => task.parentId === id)
    .flatMap((child) => (child.kind === 'summary' ? leavesOf(project, child.id) : [child]));
}

/** Generates a rich project with the same project in another order of its tasks, links and tags. */
const reorderedArbitrary = richProjectArbitrary.chain(({ project }) =>
  fc.record({
    project: fc.constant(project),
    reordered: fc
      .record({
        tasks: permutationOf(project.tasks),
        dependencies: permutationOf(project.dependencies),
        tags: permutationOf(project.tags),
      })
      .map((lists) => ({ ...project, ...lists })),
  }),
);

/** Lists, for each person or team tag, the tasks whose working slots overlap those of another task of the same tag, comparing every pair. */
function overlappingTasksByTag(project: Project, schedule: Schedule): Map<string, string[]> {
  const calendar = unwrap(compileCalendar(project.calendar));
  const people = new Set(
    project.tags.filter((tag) => tag.representsPersonOrTeam).map((tag) => tag.id),
  );
  const slotted = project.tasks.flatMap((task) =>
    task.kind === 'task' && task.tagId !== null && people.has(task.tagId)
      ? [
          {
            task,
            tagId: task.tagId,
            slots: unwrap(
              computePlacementSlots(calendar, task, placementOf(schedule, task.id)),
            ).flat(),
          },
        ]
      : [],
  );
  const overlapping = slotted.filter((first) =>
    slotted.some(
      (second) =>
        first !== second &&
        first.tagId === second.tagId &&
        first.slots.some((a) => second.slots.some((b) => a.start < b.end && b.start < a.end)),
    ),
  );
  const result = new Map<string, string[]>();
  for (const { tagId, task } of overlapping) {
    result.set(tagId, [...(result.get(tagId) ?? []), task.id].sort());
  }
  return result;
}

const options = { timeout: PROPERTY_TEST_TIMEOUT_MS };
const START = 490_896;

describe('projects using every feature', () => {
  it(
    'respects every dependency, whatever its tags, date constraints, daily starts and outline',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const calendar = unwrap(compileCalendar(project.calendar));
          const schedule = scheduled(project);
          for (const dependency of project.dependencies) {
            const fromStart =
              dependency.type === 'startToStart' || dependency.type === 'startToFinish';
            const predecessor = actedPart(
              placementOf(schedule, dependency.predecessorId),
              dependency.predecessorBlock,
              fromStart,
            );
            const onStart = constrainsSuccessorStart(dependency);
            const successor = actedPart(
              placementOf(schedule, dependency.successorId),
              dependency.successorBlock,
              onStart,
            );
            const bound = unwrap(
              shiftWorkingHours(
                calendar,
                dependencyAnchor(dependency, predecessor),
                dependency.lagHours,
              ),
            );
            if (onStart) {
              expect(successor.start).toBeGreaterThanOrEqual(bound);
            } else {
              expect(successor.end).toBeGreaterThanOrEqual(
                unwrap(lastWorkingHourEnd(calendar, bound)),
              );
            }
          }
        }),
      );
    },
  );

  it(
    'never places work outside the working hours, each block ending where its slots end',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const calendar = unwrap(compileCalendar(project.calendar));
          const schedule = scheduled(project);
          for (const task of project.tasks) {
            if (task.kind !== 'task') {
              continue;
            }
            placementOf(schedule, task.id).segments.forEach((segment, index) => {
              const slots = unwrap(
                computeTaskSlots(calendar, {
                  start: segment.start,
                  durationHours: segmentOf(task, index).durationHours,
                  hoursPerDay: task.hoursPerDay,
                  dailyStartHour: task.dailyStartHour,
                }),
              );
              for (const slot of slots) {
                expect(unwrap(countWorkingHours(calendar, slot.start, slot.end))).toBe(
                  slot.end - slot.start,
                );
              }
              expect(slots[0]?.start).toBe(segment.start);
              expect(slots.at(-1)?.end).toBe(segment.end);
            });
          }
        }),
      );
    },
  );

  it(
    'spans every summary over its descendants, even nested to the deepest allowed level',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const schedule = scheduled(project);
          for (const task of project.tasks) {
            if (task.kind !== 'summary') {
              continue;
            }
            const placements = leavesOf(project, task.id).map((leaf) =>
              placementOf(schedule, leaf.id),
            );
            const dates = schedule.summaries.get(task.id);
            if (placements.length === 0) {
              expect(dates).toEqual({ start: null, end: null, progressPercent: null });
              continue;
            }
            expect(dates?.start).toBe(Math.min(...placements.map((placement) => placement.start)));
            expect(dates?.end).toBe(Math.max(...placements.map((placement) => placement.end)));
          }
        }),
      );
    },
  );

  it(
    'reports a date constraint as missed exactly when it is enabled and the task ends after it',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const schedule = scheduled(project);
          const expected = project.tasks.flatMap((task) => {
            if (task.kind === 'summary' || !project.options.dateConstraintsEnabled) {
              return [];
            }
            const end = placementOf(schedule, task.id).end;
            return [
              ...(task.deadline !== null && end > task.deadline ? ['DEADLINE_MISSED'] : []),
              ...(task.mustFinishOn !== null && end > task.mustFinishOn
                ? ['MUST_FINISH_ON_NOT_MET']
                : []),
            ].map((code) => `${task.id}:${code}`);
          });
          const reported = schedule.conflicts.map(
            (conflict) => `${conflict.taskId}:${conflict.code}`,
          );
          expect(reported.sort()).toEqual(expected.sort());
        }),
      );
    },
  );

  it(
    'weighs the progress of a summary by the work of its tasks, or averages its milestones when it holds no work',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const schedule = scheduled(project);
          for (const task of project.tasks) {
            if (task.kind !== 'summary') {
              continue;
            }
            const leaves = leavesOf(project, task.id);
            const work = leaves.flatMap((leaf) =>
              leaf.kind === 'task'
                ? [
                    {
                      hours: leaf.segments.reduce((sum, segment) => sum + segment.durationHours, 0),
                      progress: leaf.progressPercent,
                    },
                  ]
                : [],
            );
            const milestones = leaves.flatMap((leaf) =>
              leaf.kind === 'milestone' ? [leaf.progressPercent] : [],
            );
            const progress = schedule.summaries.get(task.id)?.progressPercent;
            if (leaves.length === 0) {
              expect(progress).toBeNull();
              continue;
            }
            const hours = work.reduce((sum, part) => sum + part.hours, 0);
            const expected =
              hours > 0
                ? work.reduce((sum, part) => sum + part.hours * part.progress, 0) / hours
                : milestones.reduce((sum, value) => sum + value, 0) / milestones.length;
            expect(progress).toBeCloseTo(expected, 9);
          }
        }),
      );
    },
  );

  it(
    'ignores the date constraints of a project that keeps them turned off, as if they were empty',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const off = {
            ...project,
            options: { ...project.options, dateConstraintsEnabled: false },
          };
          const emptied = {
            ...off,
            tasks: off.tasks.map((task) =>
              task.kind === 'summary' ? task : { ...task, mustFinishOn: null, deadline: null },
            ),
          };
          const kept = scheduled(off);
          const without = scheduled(emptied);
          expect(kept.placements).toEqual(without.placements);
          expect(kept.summaries).toEqual(without.summaries);
          expect(kept.conflicts).toEqual([]);
        }),
      );
    },
  );

  it(
    'reports a person or team tag in conflict exactly for the tasks whose working slots overlap',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const schedule = scheduled(project);
          const reported = new Map<string, Set<string>>();
          for (const conflict of schedule.tagConflicts.conflicts) {
            const tasks = reported.get(conflict.tagId) ?? new Set<string>();
            conflict.taskIds.forEach((id) => tasks.add(id));
            reported.set(conflict.tagId, tasks);
          }
          const found = new Map([...reported].map(([tagId, tasks]) => [tagId, [...tasks].sort()]));
          expect(found).toEqual(overlappingTasksByTag(project, schedule));
        }),
      );
    },
  );

  it(
    'keeps unknown floats critical and passed on through every link to their first block, and known free floats within total floats',
    options,
    () => {
      fc.assert(
        fc.property(richProjectArbitrary, ({ project }) => {
          const floats = scheduled(project).floats;
          if (floats === null) {
            return;
          }
          for (const taskFloat of floats.values()) {
            if (taskFloat.totalFloatHours === null) {
              expect(taskFloat).toEqual({
                lateStart: null,
                lateFinish: null,
                totalFloatHours: null,
                freeFloatHours: null,
                isCritical: true,
              });
            } else {
              expect(taskFloat.freeFloatHours).toBeLessThanOrEqual(taskFloat.totalFloatHours);
            }
          }
          const actsOnFirstBlock = (dependency: Project['dependencies'][number]) =>
            (dependency.type === 'finishToStart' || dependency.type === 'startToStart') &&
            (dependency.successorBlock ?? 0) === 0;
          for (const dependency of project.dependencies.filter(actsOnFirstBlock)) {
            const unknownAfter = floats.get(dependency.successorId)?.totalFloatHours === null;
            const unknownBefore = floats.get(dependency.predecessorId)?.totalFloatHours === null;
            expect(unknownAfter && !unknownBefore).toBe(false);
          }
        }),
      );
    },
  );

  it('computes the same schedule whatever the order of the tasks, links and tags', options, () => {
    fc.assert(
      fc.property(reorderedArbitrary, ({ project, reordered }) => {
        const first = scheduled(project);
        const second = scheduled(reordered);
        expect(second.placements).toEqual(first.placements);
        expect(second.summaries).toEqual(first.summaries);
        expect(second.floats).toEqual(first.floats);
        expect(second.wbsNumbers).toEqual(first.wbsNumbers);
        const byTask = (conflicts: Schedule['conflicts']) =>
          conflicts.map((conflict) => `${conflict.taskId}:${conflict.code}`).sort();
        expect(byTask(second.conflicts)).toEqual(byTask(first.conflicts));
        expect(second.tagConflicts).toEqual(first.tagConflicts);
      }),
    );
  });
});

describe('a generated project whose latest dates fall before the supported years', () => {
  it('keeps its schedule, the floats it cannot work out being unknown', () => {
    const block = (durationHours: number, gapDaysBefore: number) => ({
      durationHours,
      gapDaysBefore,
      startNoEarlierThan: null,
    });
    const counterexample: Project = {
      ...project(
        [
          workTask('a', { segments: [block(0.25, 0)] }),
          workTask('b', {
            segments: [block(19.5, 0), block(27.5, 8), block(21.5, 8)],
            mustFinishOn: START,
          }),
        ],
        [link('a', 'b', 'finishToStart', 13.75)],
        {
          startDate: START,
          options: {
            criticalPathEnabled: true,
            dateConstraintsEnabled: true,
            alwaysShowPatterns: false,
          },
        },
      ),
      calendar: {
        workingWeekdays: [5],
        workingTimeRanges: [{ startHour: 4.25, endHour: 4.5 }],
        nonWorkingPeriods: [],
      },
    };
    const schedule = scheduled(counterexample);
    expect([
      schedule.floats?.get('a')?.totalFloatHours,
      schedule.floats?.get('b')?.totalFloatHours,
    ]).toEqual([null, -83]);
    expect(isBeyondHorizon({ kind: 'startDate' })).toBe(false);
    expect(
      isBeyondHorizon({ kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'a' } }),
    ).toBe(true);
  });
});
