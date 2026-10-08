import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TEST_CALENDAR } from '../testing/test-calendar';
import { countWorkingHours } from '../calendar/working-time';
import type { Tag, Task, TaskId } from '../model/project';
import type { Schedule } from '../scheduling/schedule-project';
import { computePlacementSlots } from '../scheduling/task-placement';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { compileOrThrow } from '../testing/civil-time';
import { PROJECT_START, project, scheduleOrThrow, workTask } from '../testing/project-builder';
import type { ProjectHour } from '../time';

const TAGS: Tag[] = [
  { id: 'alice', name: 'Alice', color: '#2a78d6', representsPersonOrTeam: true },
  { id: 'bob', name: 'Bob', color: '#eb6834', representsPersonOrTeam: true },
  { id: 'design', name: 'Design', color: '#1baf7a', representsPersonOrTeam: false },
];
const PERSON_TAG_IDS = ['alice', 'bob'];
const TAG_CHOICES = ['alice', 'bob', 'design', 'deleted', null] as const;
const HOURS_IN_TWO_WEEKS = 14 * 24;
const calendar = compileOrThrow(TEST_CALENDAR);

const LATEST_AFTERNOON_HOURS = 4;

const taskArbitrary = fc.record({
  tagId: fc.constantFrom(...TAG_CHOICES),
  blocks: fc.array(
    fc.record({
      durationHours: fc.integer({ min: 1, max: 20 }),
      gapDaysBefore: fc.integer({ min: 1, max: 5 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  hoursPerDay: fc.option(fc.integer({ min: 1, max: 7 })),
  dailyStartHour: fc.option(fc.constantFrom(9, 13)),
  startOffset: fc.integer({ min: 0, max: HOURS_IN_TWO_WEEKS }),
});

type TaskShape = typeof taskArbitrary extends fc.Arbitrary<infer Shape> ? Shape : never;

/** Builds tagged, possibly split tasks from random shapes, all starting within two weeks of the project start. */
function buildTasks(shapes: readonly TaskShape[]): Task[] {
  return shapes.map((shape, index) => {
    const fitsAfternoon = shape.hoursPerDay !== null && shape.hoursPerDay <= LATEST_AFTERNOON_HOURS;
    return workTask(`t${String(index).padStart(2, '0')}`, {
      tagId: shape.tagId,
      segments: shape.blocks.map((block, position) => ({
        durationHours: block.durationHours,
        gapDaysBefore: position === 0 ? 0 : block.gapDaysBefore,
        startNoEarlierThan: null,
      })),
      hoursPerDay: shape.hoursPerDay,
      dailyStartHour: fitsAfternoon ? shape.dailyStartHour : null,
      startNoEarlierThan: PROJECT_START + shape.startOffset,
    });
  });
}

/** Lists, hour by hour, which tasks of a tag are working, by brute force over every slot. */
function activeTasksByHour(
  schedule: Schedule,
  tasks: readonly Task[],
  tagId: string,
): Map<ProjectHour, TaskId[]> {
  const byHour = new Map<ProjectHour, TaskId[]>();
  for (const task of tasks.filter(
    (candidate) => candidate.kind !== 'summary' && candidate.tagId === tagId,
  )) {
    const placement = schedule.placements.get(task.id);
    const slotsByBlock =
      placement === undefined || task.kind !== 'task'
        ? []
        : unwrap(computePlacementSlots(calendar, task, placement));
    const slots = slotsByBlock.flat();
    slots.forEach((slot) => {
      for (let hour = slot.start; hour < slot.end; hour += 1) {
        byHour.set(hour, [...(byHour.get(hour) ?? []), task.id]);
      }
    });
  }
  return byHour;
}

describe('tag conflict properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('reports exactly the hours where a person works on two tasks or more, with the right tasks', () => {
    fc.assert(
      fc.property(fc.array(taskArbitrary, { maxLength: 15 }), (shapes) => {
        const tasks = buildTasks(shapes);
        const schedule = scheduleOrThrow(project(tasks, [], { tags: TAGS }));
        for (const tagId of PERSON_TAG_IDS) {
          const busyHours = [...activeTasksByHour(schedule, tasks, tagId)].filter(
            ([, ids]) => ids.length >= 2,
          );
          const conflicts = schedule.tagConflicts.conflicts.filter(
            (conflict) => conflict.tagId === tagId,
          );
          for (const [hour] of busyHours) {
            expect(
              conflicts.some((conflict) => conflict.start <= hour && hour < conflict.end),
            ).toBe(true);
          }
          for (const conflict of conflicts) {
            const inside = busyHours.filter(
              ([hour]) => conflict.start <= hour && hour < conflict.end,
            );
            const expectedTasks = [...new Set(inside.flatMap(([, ids]) => ids))].sort();
            const worked = countWorkingHours(calendar, conflict.start, conflict.end);
            expect(worked.ok && worked.value).toBe(inside.length);
            expect([...conflict.taskIds]).toEqual(expectedTasks);
          }
        }
      }),
    );
  });

  it('lists every task whose tag does not exist, and only those', () => {
    fc.assert(
      fc.property(fc.array(taskArbitrary, { maxLength: 15 }), (shapes) => {
        const tasks = buildTasks(shapes);
        const schedule = scheduleOrThrow(project(tasks, [], { tags: TAGS }));
        const expected = tasks
          .filter((task) => task.kind !== 'summary' && task.tagId === 'deleted')
          .map((task) => task.id);
        expect(schedule.tagConflicts.tasksWithUnknownTag).toEqual(expected);
      }),
    );
  });
});
