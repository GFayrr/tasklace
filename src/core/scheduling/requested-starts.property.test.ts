import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Project, TaskId } from '../model/project';
import { instantArbitrary, PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { at } from '../testing/civil-time';
import { projectArbitrary } from '../testing/project-arbitrary';
import { link, project, workTask } from '../testing/project-builder';
import { END_PROJECT_HOUR, type ProjectHour } from '../time';
import { scheduleProject, scheduleWithRequestedStarts, type Schedule } from './schedule-project';

const MAX_GENERATED_TASKS = 24;
const LAST_PROJECT_HOUR = END_PROJECT_HOUR - 1;
const USUAL_START_WEIGHT = 9;

/** Generates a requested start, now and then at the very last supported hour so that the task cannot be placed after it. */
const requestedStartArbitrary = fc.oneof(
  { arbitrary: instantArbitrary, weight: USUAL_START_WEIGHT },
  { arbitrary: fc.constant(LAST_PROJECT_HOUR), weight: 1 },
);

/** Replaces the start date of the listed tasks, a null removing it. */
function withStarts(input: Project, starts: ReadonlyMap<TaskId, ProjectHour | null>): Project {
  return {
    ...input,
    tasks: input.tasks.map((task) => {
      const start = starts.get(task.id);
      return task.kind === 'summary' || start === undefined
        ? task
        : { ...task, startNoEarlierThan: start };
    }),
  };
}

/** Runs the former two-pass algorithm: schedule without the requested starts, keep those a task would start before, then schedule again. */
function twoPassReference(
  input: Project,
  requested: ReadonlyMap<TaskId, ProjectHour>,
): { kept: Map<TaskId, ProjectHour>; schedule: Schedule } | null {
  const cleared = new Map([...requested.keys()].map((id) => [id, null]));
  const free = scheduleProject(withStarts(input, cleared));
  if (!free.ok) {
    return null;
  }
  const kept = new Map(
    [...requested].filter(([id, hour]) => (free.value.placements.get(id)?.start ?? hour) < hour),
  );
  const starts = new Map([...requested.keys()].map((id) => [id, kept.get(id) ?? null]));
  const schedule = scheduleProject(withStarts(input, starts));
  return schedule.ok ? { kept, schedule: schedule.value } : null;
}

/** Generates a project and a start requested for some of its work tasks and milestones. */
const requestArbitrary = fc
  .record({
    generated: projectArbitrary,
    starts: fc.array(fc.option(requestedStartArbitrary), {
      minLength: MAX_GENERATED_TASKS,
      maxLength: MAX_GENERATED_TASKS,
    }),
  })
  .map(({ generated, starts }) => {
    const input = generated.project;
    const requested = new Map<TaskId, ProjectHour>();
    input.tasks.forEach((task, index) => {
      const start = starts[index] ?? null;
      if (task.kind !== 'summary' && start !== null) {
        requested.set(task.id, start);
      }
    });
    return { input, requested };
  });

describe('scheduleWithRequestedStarts', () => {
  it(
    'places every task exactly as the former two-pass import did, keeping only start dates that matter',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(requestArbitrary, ({ input, requested }) => {
          const reference = twoPassReference(input, requested);
          const result = scheduleWithRequestedStarts(input, requested);
          expect(result.ok).toBe(reference !== null);
          if (!result.ok || reference === null) {
            return;
          }
          const { schedule, keptStarts } = result.value;
          expect(schedule).toEqual(reference.schedule);
          [...keptStarts].forEach(([id, hour]) => {
            expect(reference.kept.get(id)).toBe(hour);
          });
          const starts = new Map(
            [...requested.keys()].map((id) => [id, keptStarts.get(id) ?? null]),
          );
          const final = withStarts(input, starts);
          expect(unwrap(scheduleProject(final))).toEqual(schedule);
          [...keptStarts.keys()].forEach((id) => {
            const without = unwrap(scheduleProject(withStarts(final, new Map([[id, null]]))));
            expect(without.placements.get(id)?.start).toBeLessThan(
              schedule.placements.get(id)?.start ?? 0,
            );
          });
        }),
      );
    },
  );

  it(
    'returns exactly the schedule of the project with its kept starts, advanced date constraints included',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const advancedArbitrary = fc.record({
        request: requestArbitrary,
        dateConstraintsEnabled: fc.boolean(),
        mustFinishOn: fc.array(fc.option(instantArbitrary), {
          minLength: MAX_GENERATED_TASKS,
          maxLength: MAX_GENERATED_TASKS,
        }),
      });
      fc.assert(
        fc.property(advancedArbitrary, ({ request, dateConstraintsEnabled, mustFinishOn }) => {
          const input: Project = {
            ...request.input,
            options: { ...request.input.options, dateConstraintsEnabled },
            tasks: request.input.tasks.map((task, index) =>
              task.kind === 'summary'
                ? task
                : { ...task, mustFinishOn: mustFinishOn[index] ?? null },
            ),
          };
          const result = scheduleWithRequestedStarts(input, request.requested);
          fc.pre(result.ok);
          const { schedule, keptStarts } = result.value;
          const starts = new Map(
            [...request.requested.keys()].map((id) => [id, keptStarts.get(id) ?? null]),
          );
          expect(unwrap(scheduleProject(withStarts(input, starts)))).toEqual(schedule);
        }),
      );
    },
  );

  it('fails like the former import when a requested start leaves no room before the last supported hour', () => {
    const late = project([workTask('a')]);
    const requested = new Map([['a', LAST_PROJECT_HOUR]]);
    expect(scheduleWithRequestedStarts(late, requested)).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'a' } },
    });
    expect(twoPassReference(late, requested)).toBeNull();
  });

  it('drops the start date of a task its predecessor already pushes past it', () => {
    const chain = project([workTask('a'), workTask('b')], [link('a', 'b')]);
    const requested = new Map([
      ['a', at(2026, 10, 5, 9)],
      ['b', at(2026, 10, 1, 9)],
    ]);
    const result = unwrap(scheduleWithRequestedStarts(chain, requested));
    expect([...result.keptStarts]).toEqual([['a', at(2026, 10, 5, 9)]]);
    expect(result.schedule.placements.get('b')?.start).toBe(at(2026, 10, 6, 9));
    expect(twoPassReference(chain, requested)?.kept.size).toBe(2);
  });
});
