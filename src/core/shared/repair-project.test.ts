import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_DEPENDENCIES,
  MAX_HIERARCHY_DEPTH,
  MAX_MERGE_REPAIR_ROUNDS,
  MAX_TAGS,
  MAX_TASKS,
} from '../limits';
import type { Dependency, Project, Tag, Task } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { link, milestone, project, summary, workTask } from '../testing/project-builder';
import { readProject, STORED_VALUE_CODEC } from '../validation/read-project';
import { repairProject } from './repair-project';

const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#336699',
  representsPersonOrTeam: false,
};

/** Repairs a project built from tasks, dependencies and optional project overrides, failing the test when the repair is refused. */
function repair(
  tasks: readonly Task[],
  dependencies: readonly Dependency[] = [],
  overrides: Partial<Project> = {},
) {
  return unwrap(repairProject(project(tasks, dependencies, overrides)));
}

/** Tells whether a project passes the complete validation. */
function isValid(input: Project): boolean {
  return readProject(input, STORED_VALUE_CODEC).ok;
}

describe('repairProject', () => {
  it('leaves a valid project unchanged', () => {
    const valid = project(
      [summary('s'), workTask('a', { parentId: 's' }), milestone('m')],
      [link('a', 'm')],
    );
    expect(repairProject(valid)).toEqual({ ok: true, value: { project: valid, repairs: [] } });
  });

  it('clears the tag of tasks pointing at a deleted tag', () => {
    const result = repair(
      [workTask('a', { tagId: 'gone' }), workTask('b', { tagId: 'design' })],
      [],
      {
        tags: [DESIGN],
      },
    );
    expect(result.repairs).toEqual([{ code: 'TAG_CLEARED', id: 'a' }]);
    expect(result.project.tasks.map((task) => task.kind !== 'summary' && task.tagId)).toEqual([
      null,
      'design',
    ]);
  });

  it('moves to the root the tasks whose parent was deleted or is no longer a summary', () => {
    const result = repair([
      workTask('a', { parentId: 'gone' }),
      workTask('b'),
      workTask('c', { parentId: 'b' }),
    ]);
    expect(result.repairs).toEqual([
      { code: 'MOVED_TO_ROOT', id: 'a' },
      { code: 'MOVED_TO_ROOT', id: 'c' },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('breaks a hierarchy loop by moving its task with the smallest identifier to the root', () => {
    const result = repair([
      summary('q', { parentId: 'p' }),
      summary('p', { parentId: 'q' }),
      summary('self', { parentId: 'self' }),
    ]);
    expect(result.repairs).toEqual([
      { code: 'MOVED_TO_ROOT', id: 'p' },
      { code: 'MOVED_TO_ROOT', id: 'self' },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('moves too deep tasks to the root, smallest identifier first, until the tree fits', () => {
    const chain = Array.from({ length: MAX_HIERARCHY_DEPTH + 2 }, (_unused, index) =>
      summary(`s${String(index).padStart(2, '0')}`, {
        parentId: index === 0 ? null : `s${String(index - 1).padStart(2, '0')}`,
      }),
    );
    const result = repair(chain);
    expect(result.repairs).toEqual([
      { code: 'MOVED_TO_ROOT', id: `s${String(MAX_HIERARCHY_DEPTH)}` },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('removes dependencies towards deleted tasks, the same task or a summary', () => {
    const result = repair(
      [summary('s'), workTask('a'), workTask('b')],
      [link('a', 'gone'), link('a', 'a'), link('s', 'b'), link('a', 'b')],
    );
    expect(result.repairs.map((repair) => repair.id)).toEqual(['a-a', 'a-gone', 's-b']);
    expect(result.project.dependencies).toEqual([link('a', 'b')]);
  });

  it('keeps the dependency with the smallest identifier between the same two tasks', () => {
    const result = repair(
      [workTask('a'), workTask('b')],
      [
        { ...link('a', 'b'), id: 'z' },
        { ...link('a', 'b', 'startToStart'), id: 'k' },
      ],
    );
    expect(result.repairs).toEqual([{ code: 'DEPENDENCY_REMOVED', id: 'z' }]);
    expect(result.project.dependencies.map((dependency) => dependency.id)).toEqual(['k']);
  });

  it('removes the dependency with the greatest identifier of each cycle', () => {
    const result = repair(
      [workTask('a'), workTask('b'), workTask('c'), workTask('d'), workTask('e')],
      [
        link('a', 'b'),
        link('b', 'c'),
        link('c', 'a'),
        link('d', 'e'),
        link('e', 'd'),
        link('c', 'd'),
      ],
    );
    expect(result.repairs).toEqual([
      { code: 'DEPENDENCY_REMOVED', id: 'c-a' },
      { code: 'DEPENDENCY_REMOVED', id: 'e-d' },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('removes the dependency with the greatest identifier wherever it stands in the cycle', () => {
    const result = repair(
      [workTask('a'), workTask('b'), workTask('c')],
      [
        { ...link('a', 'b'), id: 'k' },
        { ...link('b', 'c'), id: 'z' },
        { ...link('c', 'a'), id: 'm' },
      ],
    );
    expect(result.repairs).toEqual([{ code: 'DEPENDENCY_REMOVED', id: 'z' }]);
    expect(result.project.dependencies.map((dependency) => dependency.id).sort()).toEqual([
      'k',
      'm',
    ]);
  });

  it('fits hours per day and daily start hours to the calendar', () => {
    const result = repair([
      workTask('a', { hoursPerDay: 10 }),
      workTask('b', { hoursPerDay: 3, dailyStartHour: 16 }),
      workTask('c', { hoursPerDay: 3, dailyStartHour: 14 }),
    ]);
    expect(result.repairs).toEqual([
      { code: 'HOURS_PER_DAY_REDUCED', id: 'a' },
      { code: 'DAILY_START_HOUR_CLEARED', id: 'b' },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('leaves daily patterns alone when the calendar itself is invalid', () => {
    const calendar = { workingWeekdays: [], workingTimeRanges: [], nonWorkingPeriods: [] };
    const result = repair([workTask('a', { hoursPerDay: 10 })], [], { calendar });
    expect(result.repairs).toEqual([]);
  });

  it('repairs what the removal of tasks beyond the limit leaves behind', () => {
    const fillers = Array.from({ length: MAX_TASKS }, (_unused, index) =>
      milestone(`a${String(index).padStart(6, '0')}`),
    );
    const result = repair(
      [...fillers, summary('z1'), workTask('z2', { parentId: 'z1' })],
      [link('a000000', 'z2')],
    );
    expect(result.repairs).toEqual([
      { code: 'TASK_REMOVED', id: 'z1' },
      { code: 'TASK_REMOVED', id: 'z2' },
      { code: 'DEPENDENCY_REMOVED', id: 'a000000-z2' },
    ]);
    expect(isValid(result.project)).toBe(true);
  });

  it('keeps the dependencies with the smallest identifiers beyond the limit', () => {
    const dependencies = Array.from({ length: MAX_DEPENDENCIES + 1 }, (_unused, index) => ({
      ...link('a', 'b'),
      id: `d${String(index).padStart(6, '0')}`,
    }));
    const result = repair([workTask('a'), workTask('b')], dependencies);
    expect(result.repairs[0]).toEqual({
      code: 'DEPENDENCY_REMOVED',
      id: `d${String(MAX_DEPENDENCIES).padStart(6, '0')}`,
    });
    expect(result.project.dependencies.map((dependency) => dependency.id)).toEqual(['d000000']);
  });

  it('keeps the tasks and tags with the smallest identifiers beyond the limits', () => {
    const tasks = Array.from({ length: MAX_TASKS + 2 }, (_unused, index) =>
      milestone(`m${String(index).padStart(6, '0')}`),
    );
    const tags = Array.from({ length: MAX_TAGS + 1 }, (_unused, index) => ({
      ...DESIGN,
      id: `t${String(index).padStart(3, '0')}`,
    }));
    const result = repair(tasks, [], { tags });
    expect(result.repairs).toEqual([
      { code: 'TASK_REMOVED', id: `m${String(MAX_TASKS).padStart(6, '0')}` },
      { code: 'TASK_REMOVED', id: `m${String(MAX_TASKS + 1).padStart(6, '0')}` },
      { code: 'TAG_REMOVED', id: `t${String(MAX_TAGS)}` },
    ]);
    expect(result.project.tasks).toHaveLength(MAX_TASKS);
  });
});

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

const brokenProjectArbitrary = fc
  .record({
    kinds: fc.array(fc.constantFrom('task', 'milestone', 'summary'), {
      minLength: IDS.length,
      maxLength: IDS.length,
    }),
    parents: fc.array(fc.option(fc.constantFrom(...IDS, 'gone')), {
      minLength: IDS.length,
      maxLength: IDS.length,
    }),
    tags: fc.array(fc.option(fc.constantFrom('design', 'gone')), {
      minLength: IDS.length,
      maxLength: IDS.length,
    }),
    hoursPerDay: fc.array(fc.option(fc.integer({ min: 1, max: 24 })), {
      minLength: IDS.length,
      maxLength: IDS.length,
    }),
    dailyStartHours: fc.array(fc.option(fc.integer({ min: 0, max: 23 })), {
      minLength: IDS.length,
      maxLength: IDS.length,
    }),
    links: fc.array(
      fc.record({
        id: fc.stringMatching(/^[a-z]{1,3}$/),
        from: fc.constantFrom(...IDS, 'gone'),
        to: fc.constantFrom(...IDS),
      }),
      { maxLength: 12 },
    ),
  })
  .map(({ kinds, parents, tags, hoursPerDay, dailyStartHours, links }): Project => {
    const tasks = IDS.map((id, index): Task => {
      const parentId = parents[index] ?? null;
      const kind = kinds[index] ?? 'task';
      if (kind === 'summary') {
        return summary(id, { parentId });
      }
      const tagId = tags[index] ?? null;
      return kind === 'milestone'
        ? milestone(id, { parentId, tagId })
        : workTask(id, {
            parentId,
            tagId,
            hoursPerDay: hoursPerDay[index] ?? null,
            dailyStartHour: dailyStartHours[index] ?? null,
          });
    });
    const dependencies = [...new Map(links.map((item) => [item.id, item])).values()].map(
      (item) => ({ ...link(item.from, item.to), id: item.id }),
    );
    return project(tasks, dependencies, { tags: [DESIGN] });
  });

describe('repairProject properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('always yields a valid project that a second repair leaves unchanged', () => {
    fc.assert(
      fc.property(brokenProjectArbitrary, (broken) => {
        const once = unwrap(repairProject(broken));
        expect(readProject(once.project, STORED_VALUE_CODEC).ok).toBe(true);
        expect(repairProject(once.project)).toEqual({
          ok: true,
          value: { project: once.project, repairs: [] },
        });
      }),
    );
  });

  it('does not depend on the order of the data', () => {
    fc.assert(
      fc.property(
        brokenProjectArbitrary.chain((broken) =>
          fc.record({
            broken: fc.constant(broken),
            tasks: fc.shuffledSubarray([...broken.tasks], { minLength: broken.tasks.length }),
            dependencies: fc.shuffledSubarray([...broken.dependencies], {
              minLength: broken.dependencies.length,
            }),
          }),
        ),
        ({ broken, tasks, dependencies }) => {
          /** Returns items ordered by identifier. */
          const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
            [...items].sort((left, right) => (left.id < right.id ? -1 : 1));
          const first = unwrap(repairProject(broken));
          const second = unwrap(repairProject({ ...broken, tasks, dependencies }));
          expect(second.repairs).toEqual(first.repairs);
          expect(byId(second.project.tasks)).toEqual(byId(first.project.tasks));
          expect(byId(second.project.dependencies)).toEqual(byId(first.project.dependencies));
        },
      ),
    );
  });

  it('gives up when breaking the cycles needs more rounds than allowed', () => {
    const pairs = Array.from(
      { length: MAX_MERGE_REPAIR_ROUNDS + 1 },
      (_, index) => [`p${String(index)}`, `q${String(index)}`] as const,
    );
    const tasks = pairs.flatMap(([first, second]) => [workTask(first), workTask(second)]);
    const dependencies = pairs.flatMap(([first, second]) => [
      link(first, second),
      link(second, first),
    ]);
    expect(repairProject(project(tasks, dependencies))).toEqual({
      ok: false,
      error: 'TOO_MANY_REPAIRS',
    });
    expect(repairProject(project(tasks.slice(2), dependencies.slice(2))).ok).toBe(true);
  });
});
