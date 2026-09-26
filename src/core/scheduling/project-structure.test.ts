import { describe, expect, it } from 'vitest';
import { MAX_DEPENDENCIES, MAX_HIERARCHY_DEPTH, MAX_LAG_HOURS, MAX_TASKS } from '../limits';
import type { Dependency, Task } from '../model/project';
import { link, milestone, summary, workTask } from '../testing/project-builder';
import { analyzeProjectStructure, findNewDependencyErrors } from './project-structure';

/** Returns the error codes found in a project, or an empty list when it is valid. */
function errorCodes(tasks: readonly Task[], dependencies: readonly Dependency[] = []): string[] {
  const result = analyzeProjectStructure({ tasks, dependencies });
  return result.ok ? [] : result.error.map((error) => error.code);
}

/** Builds a chain of nested summaries of the given depth, the deepest one holding a task. */
function nestedSummaries(depth: number): Task[] {
  const summaries = Array.from({ length: depth }, (_value, index) =>
    summary(`s${String(index)}`, { parentId: index === 0 ? null : `s${String(index - 1)}` }),
  );
  return [...summaries, workTask('leaf', { parentId: `s${String(depth - 1)}` })];
}

describe('analyzeProjectStructure', () => {
  it('accepts an empty project', () => {
    expect(errorCodes([])).toEqual([]);
  });

  it('accepts a valid tree with dependencies between tasks and milestones', () => {
    const tasks = [
      summary('phase'),
      workTask('a', { parentId: 'phase' }),
      workTask('b', { parentId: 'phase' }),
      milestone('m'),
    ];
    expect(errorCodes(tasks, [link('a', 'b'), link('b', 'm')])).toEqual([]);
  });

  it('orders every predecessor before its successors', () => {
    const tasks = [workTask('c'), workTask('b'), workTask('a')];
    const result = analyzeProjectStructure({
      tasks,
      dependencies: [link('a', 'b'), link('b', 'c')],
    });
    expect(result.ok && result.value.graph.order.map((node) => node.task.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it.each<[string, Task[], string]>([
    ['duplicated task identifiers', [workTask('a'), workTask('a')], 'DUPLICATE_TASK_ID'],
    ['an unknown parent', [workTask('a', { parentId: 'ghost' })], 'UNKNOWN_PARENT'],
    [
      'a parent that is not a summary',
      [workTask('a'), workTask('b', { parentId: 'a' })],
      'PARENT_NOT_SUMMARY',
    ],
    [
      'a parent that is a milestone',
      [milestone('m'), workTask('b', { parentId: 'm' })],
      'PARENT_NOT_SUMMARY',
    ],
  ])('rejects %s', (_label, tasks, code) => {
    expect(errorCodes(tasks)).toContain(code);
  });

  it('rejects a summary that is its own parent', () => {
    expect(errorCodes([summary('s', { parentId: 's' })])).toEqual(['HIERARCHY_CYCLE']);
  });

  it('rejects a loop of summaries', () => {
    const tasks = [summary('a', { parentId: 'b' }), summary('b', { parentId: 'a' })];
    expect(errorCodes(tasks)).toEqual(['HIERARCHY_CYCLE', 'HIERARCHY_CYCLE']);
  });

  it('accepts the maximum depth and rejects one level more', () => {
    expect(errorCodes(nestedSummaries(MAX_HIERARCHY_DEPTH - 1))).toEqual([]);
    expect(errorCodes(nestedSummaries(MAX_HIERARCHY_DEPTH))).toContain('HIERARCHY_TOO_DEEP');
  });

  it.each<[string, Dependency[], string]>([
    ['an unknown predecessor', [link('ghost', 'a')], 'UNKNOWN_DEPENDENCY_TASK'],
    ['an unknown successor', [link('a', 'ghost')], 'UNKNOWN_DEPENDENCY_TASK'],
    ['a task depending on itself', [link('a', 'a')], 'SELF_DEPENDENCY'],
    ['a dependency from a summary', [link('phase', 'a')], 'SUMMARY_DEPENDENCY'],
    ['a dependency to a summary', [link('a', 'phase')], 'SUMMARY_DEPENDENCY'],
    [
      'two dependencies between the same tasks',
      [link('a', 'b'), { ...link('a', 'b', 'startToStart'), id: 'other' }],
      'DUPLICATE_DEPENDENCY',
    ],
    [
      'duplicated dependency identifiers',
      [link('a', 'b'), { ...link('b', 'm'), id: 'a->b' }],
      'DUPLICATE_DEPENDENCY_ID',
    ],
    ['a fractional lag', [link('a', 'b', 'finishToStart', 1.5)], 'INVALID_LAG'],
    ['a NaN lag', [link('a', 'b', 'finishToStart', Number.NaN)], 'INVALID_LAG'],
    [
      'a lag above the maximum',
      [link('a', 'b', 'finishToStart', MAX_LAG_HOURS + 1)],
      'INVALID_LAG',
    ],
    [
      'a lead above the maximum',
      [link('a', 'b', 'finishToStart', -MAX_LAG_HOURS - 1)],
      'INVALID_LAG',
    ],
  ])('rejects %s', (_label, dependencies, code) => {
    const tasks = [summary('phase'), workTask('a'), workTask('b'), milestone('m')];
    expect(errorCodes(tasks, dependencies)).toEqual([code]);
  });

  it('accepts the maximum lag and lead', () => {
    const tasks = [workTask('a'), workTask('b'), workTask('c')];
    const dependencies = [
      link('a', 'b', 'finishToStart', MAX_LAG_HOURS),
      link('b', 'c', 'finishToStart', -MAX_LAG_HOURS),
    ];
    expect(errorCodes(tasks, dependencies)).toEqual([]);
  });

  it('accepts dependencies in opposite directions between different pairs', () => {
    const tasks = [workTask('a'), workTask('b'), workTask('c')];
    expect(errorCodes(tasks, [link('a', 'b'), link('a', 'c'), link('b', 'c')])).toEqual([]);
  });

  it('rejects a two-task cycle and names the tasks involved', () => {
    const result = analyzeProjectStructure({
      tasks: [workTask('a'), workTask('b'), workTask('c')],
      dependencies: [link('a', 'b'), link('b', 'a')],
    });
    expect(!result.ok && result.error).toEqual([
      { code: 'DEPENDENCY_CYCLE', taskId: 'a' },
      { code: 'DEPENDENCY_CYCLE', taskId: 'b' },
    ]);
  });

  it('rejects a long cycle, whatever the dependency types', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => workTask(id));
    const dependencies = [
      link('a', 'b', 'startToStart'),
      link('b', 'c', 'finishToFinish'),
      link('c', 'd', 'startToFinish'),
      link('d', 'a'),
    ];
    expect(errorCodes(tasks, dependencies)).toEqual([
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
    ]);
  });

  it('rejects projects with too many tasks or dependencies before any other check', () => {
    const manyTasks = Array.from({ length: MAX_TASKS + 1 }, () => workTask('same'));
    expect(errorCodes(manyTasks)).toEqual(['TOO_MANY_TASKS']);
    const manyLinks = Array.from({ length: MAX_DEPENDENCIES + 1 }, () => link('x', 'y'));
    expect(errorCodes([], manyLinks)).toEqual(['TOO_MANY_DEPENDENCIES']);
  });
});

describe('findNewDependencyErrors', () => {
  const current = {
    tasks: [workTask('a'), workTask('b'), workTask('c')],
    dependencies: [link('a', 'b'), link('b', 'c')],
  };

  it('accepts a dependency that keeps the network acyclic', () => {
    expect(findNewDependencyErrors(current, link('a', 'c'))).toEqual([]);
  });

  it('refuses a dependency that closes a cycle', () => {
    const errors = findNewDependencyErrors(current, link('c', 'a'));
    expect(errors.map((error) => error.code)).toEqual([
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
    ]);
  });

  it('refuses a second dependency between the same tasks', () => {
    const errors = findNewDependencyErrors(current, {
      ...link('a', 'b', 'finishToFinish'),
      id: 'x',
    });
    expect(errors).toEqual([{ code: 'DUPLICATE_DEPENDENCY', dependencyId: 'x' }]);
  });
});
