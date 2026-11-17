import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Task } from '../model/project';
import { link, project, testId, workTask } from '../testing/project-builder';
import { projectChanges } from './project-changes';

const NOTHING = { put: [], removed: [] };

describe('projectChanges', () => {
  const tasks: readonly [Task, ...Task[]] = [workTask('b'), workTask('d'), workTask('f')];
  const start = project(tasks, [link('b', 'd')]);

  it('finds nothing between a project and itself, nor between two projects sharing their lists and header values', () => {
    expect(projectChanges(start, start)).toEqual({
      header: false,
      tasks: NOTHING,
      dependencies: NOTHING,
      tags: NOTHING,
    });
    expect(projectChanges(start, { ...start, tasks: [...tasks] })).toEqual({
      header: false,
      tasks: NOTHING,
      dependencies: NOTHING,
      tags: NOTHING,
    });
  });

  it('gives the items added or replaced and the identifiers removed, at the start, in the middle and at the end', () => {
    const [first] = tasks;
    const renamed = workTask('d', { name: 'Renamed' });
    const a = workTask('a');
    const c = workTask('c');
    const g = workTask('g');
    const next = { ...start, tasks: [a, first, c, renamed, g], dependencies: [] };
    expect(projectChanges(start, next)).toEqual({
      header: false,
      tasks: { put: [a, c, renamed, g], removed: [testId('f')] },
      dependencies: { put: [], removed: [testId('b-d')] },
      tags: NOTHING,
    });
  });

  it('tells when a field of the header holds another value', () => {
    expect(projectChanges(start, { ...start, name: 'Other' }).header).toBe(true);
    expect(projectChanges(start, { ...start, options: { ...start.options } }).header).toBe(true);
  });

  it('agrees with a comparison of every pair of items', () => {
    const pairs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id): readonly [Task, Task] => {
      const task = workTask(id);
      return [task, { ...task, name: `${task.name} again` }];
    });
    const list = fc
      .subarray(pairs)
      .chain((chosen) => fc.tuple(...chosen.map((pair) => fc.constantFrom(...pair))));
    fc.assert(
      fc.property(list, list, (before, after) => {
        const changes = projectChanges(project(before), project(after));
        const previous = new Map(before.map((task) => [task.id, task]));
        const next = new Set(after.map((task) => task.id));
        expect(changes.tasks).toEqual({
          put: after.filter((task) => previous.get(task.id) !== task),
          removed: before.filter((task) => !next.has(task.id)).map((task) => task.id),
        });
      }),
    );
  });
});
