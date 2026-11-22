import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Project, Tag } from '../model/project';
import { link, project, testId, workTask } from '../testing/project-builder';
import {
  closesCycle,
  createProjectState,
  projectAfterChanges,
  putDependency,
  putTag,
  putTask,
  removeDependency,
  removeTag,
  removeTask,
  toProject,
  type ProjectState,
} from './project-state';

describe('closesCycle', () => {
  it('counts a link from or to a task missing from the state as a loop, so that nothing doubtful is accepted', () => {
    const state = createProjectState(project([workTask('a'), workTask('b')]));
    expect(closesCycle(state, link('a', 'gone'))).toBe(true);
    expect(closesCycle(state, link('gone', 'b'))).toBe(true);
    expect(closesCycle(state, link('a', 'b'))).toBe(false);
  });

  it('finds the loop a link would close back to the task it leaves', () => {
    const state = createProjectState(project([workTask('a'), workTask('b')], [link('a', 'b')]));
    expect(closesCycle(state, link('b', 'a'))).toBe(true);
  });
});

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

type StateOperation =
  | { readonly kind: 'putTask'; readonly id: string; readonly name: string }
  | { readonly kind: 'removeTask'; readonly id: string }
  | { readonly kind: 'putDependency'; readonly from: string; readonly to: string }
  | { readonly kind: 'removeDependency'; readonly from: string; readonly to: string }
  | { readonly kind: 'putTag'; readonly id: string; readonly name: string }
  | { readonly kind: 'removeTag'; readonly id: string };

const stateOperation: fc.Arbitrary<StateOperation> = fc.oneof(
  fc.record({
    kind: fc.constant('putTask' as const),
    id: fc.constantFrom(...IDS),
    name: fc.string(),
  }),
  fc.record({ kind: fc.constant('removeTask' as const), id: fc.constantFrom(...IDS) }),
  fc.record({
    kind: fc.constant('putDependency' as const),
    from: fc.constantFrom(...IDS),
    to: fc.constantFrom(...IDS),
  }),
  fc.record({
    kind: fc.constant('removeDependency' as const),
    from: fc.constantFrom(...IDS),
    to: fc.constantFrom(...IDS),
  }),
  fc.record({
    kind: fc.constant('putTag' as const),
    id: fc.constantFrom(...IDS),
    name: fc.string(),
  }),
  fc.record({ kind: fc.constant('removeTag' as const), id: fc.constantFrom(...IDS) }),
);

/** Returns a tag of the tests with an identifier and a name. */
function tagOf(id: string, name: string): Tag {
  return { id: testId(id), name, color: '#336699', representsPersonOrTeam: false };
}

/** Runs one operation of the tests on an indexed state through the functions the session uses. */
function runOn(state: ProjectState, operation: StateOperation): void {
  switch (operation.kind) {
    case 'putTask':
      putTask(state, workTask(operation.id, { name: operation.name }));
      return;
    case 'removeTask':
      removeTask(state, testId(operation.id));
      return;
    case 'putDependency':
      putDependency(state, link(operation.from, operation.to));
      return;
    case 'removeDependency':
      removeDependency(state, link(operation.from, operation.to).id);
      return;
    case 'putTag':
      putTag(state, tagOf(operation.id, operation.name));
      return;
    case 'removeTag':
      removeTag(state, testId(operation.id));
  }
}

/** Names what an operation touches by its list and identifier, since a task, a dependency and a tag may share an identifier. */
function touchedKey(operation: StateOperation): string {
  switch (operation.kind) {
    case 'putTask':
    case 'removeTask':
      return `task ${operation.id}`;
    case 'putDependency':
    case 'removeDependency':
      return `dependency ${link(operation.from, operation.to).id}`;
    case 'putTag':
    case 'removeTag':
      return `tag ${operation.id}`;
  }
}

/** Lists the items of a project, each with its list and identifier. */
function keyedItems(project: Project): (readonly [string, object])[] {
  return [
    ...project.tasks.map((task) => [`task ${task.id}`, task] as const),
    ...project.dependencies.map(
      (dependency) => [`dependency ${dependency.id}`, dependency] as const,
    ),
    ...project.tags.map((tag) => [`tag ${tag.id}`, tag] as const),
  ];
}

describe('projectAfterChanges', () => {
  const start = project(
    [workTask('b'), workTask('d'), workTask('f')],
    [link('b', 'd'), link('d', 'f')],
    { tags: [tagOf('t', 'Design')] },
  );

  it('keeps the lists nothing touched and the items it did not touch, and forgets what was touched', () => {
    const state = createProjectState(start);
    putTask(state, workTask('d', { name: 'Renamed' }));
    const next = projectAfterChanges(state, start);
    expect(next).toEqual(toProject(state));
    expect(next.dependencies).toBe(start.dependencies);
    expect(next.tags).toBe(start.tags);
    expect(next.tasks[0]).toBe(start.tasks[0]);
    expect(next.tasks[2]).toBe(start.tasks[2]);
    expect(next.tasks[1]?.name).toBe('Renamed');
    expect([...state.touched.tasks]).toEqual([]);
    expect(projectAfterChanges(state, next).tasks).toBe(next.tasks);
  });

  it('places added items before, between and after the others, and drops removed ones', () => {
    const state = createProjectState(start);
    putTask(state, workTask('a'));
    putTask(state, workTask('c'));
    putTask(state, workTask('g'));
    removeTask(state, testId('f'));
    removeDependency(state, link('d', 'f').id);
    removeTag(state, testId('t'));
    const next = projectAfterChanges(state, start);
    expect(next.tasks.map((task) => task.id)).toEqual(['a', 'b', 'c', 'd', 'g']);
    expect(next.dependencies.map((dependency) => dependency.id)).toEqual(['b-d']);
    expect(next.tags).toEqual([]);
    expect(next).toEqual(toProject(state));
  });

  it('gives the project a full rebuild would give after any operations, items untouched keeping their identity', () => {
    fc.assert(
      fc.property(fc.array(fc.array(stateOperation), { maxLength: 6 }), (rounds) => {
        const state = createProjectState(start);
        let previous = start;
        for (const operations of rounds) {
          const touched = new Set<string>();
          operations.forEach((operation) => {
            runOn(state, operation);
            touched.add(touchedKey(operation));
          });
          const next = projectAfterChanges(state, previous);
          expect(next).toEqual(toProject(state));
          const before = new Map(keyedItems(previous));
          expect(
            keyedItems(next)
              .filter(([key, item]) => !touched.has(key) && before.get(key) !== item)
              .map(([key]) => key),
          ).toEqual([]);
          previous = next;
        }
      }),
    );
  });
});
