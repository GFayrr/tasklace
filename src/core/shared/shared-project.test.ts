import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { DependencyType, Project, Tag, Task } from '../model/project';
import { compareStrings } from '../compare-strings';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { at } from '../testing/civil-time';
import { projectArbitrary } from '../testing/project-arbitrary';
import { link, milestone, project, summary, workTask } from '../testing/project-builder';
import { createSharedDocument, readSharedData, TASKS_ROOT } from './shared-document';
import {
  applySharedChange,
  mergeSharedUpdate,
  readSharedProject,
  repairSharedDocument,
  type SharedRepair,
} from './shared-project';

const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#336699',
  representsPersonOrTeam: false,
};
const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#aa5500', representsPersonOrTeam: true };
const MORNING_ONLY = [{ startHour: 9, endHour: 12 }];
const FULL_DAY = [{ startHour: 0, endHour: 24 }];

const BASE_PROJECT: Project = project(
  [
    summary('s1'),
    summary('s2', { parentId: 's1' }),
    workTask('a', { parentId: 's1', tagId: 'design' }),
    workTask('b', { parentId: 's2' }),
    workTask('c'),
    milestone('m'),
  ],
  [link('a', 'b'), link('b', 'm')],
  { tags: [DESIGN, ALICE] },
);

/** Creates participants sharing the same project, each with a fixed client identifier. */
function createPeers(base: Project, count: number): Y.Doc[] {
  const origin = createSharedDocument(base);
  return Array.from({ length: count }, (_unused, index) => {
    const peer = new Y.Doc();
    peer.clientID = index + 1;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(origin));
    return peer;
  });
}

/** Sends to a participant everything it is missing from another one, returning the repairs made on arrival. */
function sync(from: Y.Doc, to: Y.Doc): readonly SharedRepair[] {
  const merged = mergeSharedUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  if (!merged.ok) {
    throw new Error(JSON.stringify(merged.error));
  }
  return merged.value;
}

/** Exchanges updates between every pair of participants until nothing changes any more. */
function syncAll(peers: readonly Y.Doc[]): void {
  const rounds = peers.length + 1;
  const pairs = peers.flatMap((left) =>
    peers.filter((right) => right !== left).map((right) => [left, right] as const),
  );
  for (let round = 0; round < rounds; round += 1) {
    for (const [from, to] of pairs) {
      sync(from, to);
    }
  }
}

/** Reads the project of a participant, failing the test when it is invalid. */
function projectOf(peer: Y.Doc): Project {
  const read = readSharedProject(peer);
  if (!read.ok) {
    throw new Error(JSON.stringify(read.error));
  }
  return read.value;
}

/** Applies a local change, failing the test when it is refused. */
function change(peer: Y.Doc, update: (current: Project) => Project): void {
  const result = applySharedChange(peer, update);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
}

/** Replaces one task of a project by the result of a function. */
function mapTask(current: Project, id: string, update: (task: Task) => Task): Project {
  return { ...current, tasks: current.tasks.map((task) => (task.id === id ? update(task) : task)) };
}

/** Sorts a list of identified items by identifier. */
function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareStrings(left.id, right.id));
}

/** Runs two concurrent changes on two participants, merges them both ways and returns the repairs and the final project. */
function mergeConcurrent(
  base: Project,
  first: (current: Project) => Project,
  second: (current: Project) => Project,
): { readonly repairs: readonly SharedRepair[]; readonly project: Project } {
  const [left, right] = createPeers(base, 2);
  if (left === undefined || right === undefined) {
    throw new Error('Missing participant');
  }
  change(left, first);
  change(right, second);
  const repairs = sync(left, right);
  sync(right, left);
  expect(readSharedData(left)).toEqual(readSharedData(right));
  return { repairs, project: projectOf(right) };
}

describe('shared document', () => {
  it('holds a project and gives it back unchanged, lists sorted by identifier', () => {
    const baseline = {
      takenAt: at(2026, 9, 27, 10),
      entries: [
        { taskId: 'a', start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 17), durationHours: 7 },
      ],
    };
    const input = { ...BASE_PROJECT, baseline };
    const read = projectOf(createSharedDocument(input));
    expect({
      ...read,
      tasks: byId(read.tasks),
      dependencies: byId(read.dependencies),
      tags: byId(read.tags),
    }).toEqual({
      ...input,
      tasks: byId(input.tasks),
      dependencies: byId(input.dependencies),
      tags: byId(input.tags),
    });
  });

  it('gives back every generated project', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(projectArbitrary, ({ project: input }) => {
        const read = projectOf(createSharedDocument(input));
        expect(byId(read.tasks)).toEqual(byId(input.tasks));
        expect(byId(read.dependencies)).toEqual(byId(input.dependencies));
        expect(read.calendar).toEqual(input.calendar);
      }),
    );
  });

  it('writes nothing when a change leaves the project as it was', () => {
    const [peer] = createPeers(BASE_PROJECT, 1);
    if (peer === undefined) {
      throw new Error('Missing participant');
    }
    let updates = 0;
    peer.on('update', () => {
      updates += 1;
    });
    change(peer, (current) => current);
    expect(updates).toBe(0);
  });

  it('refuses an invalid local change and leaves the document untouched', () => {
    const [peer] = createPeers(BASE_PROJECT, 1);
    if (peer === undefined) {
      throw new Error('Missing participant');
    }
    const before = Y.encodeStateAsUpdate(peer);
    const result = applySharedChange(peer, (current) => ({
      ...current,
      dependencies: [...current.dependencies, link('m', 'a')],
    }));
    expect(result.ok).toBe(false);
    expect(Y.encodeStateAsUpdate(peer)).toEqual(before);
  });

  it('keeps the fields of the former kind hidden when a task becomes a summary', () => {
    const [peer] = createPeers(BASE_PROJECT, 1);
    if (peer === undefined) {
      throw new Error('Missing participant');
    }
    change(peer, (current) => ({
      ...mapTask(current, 'c', (task) => summary(task.id, { name: task.name })),
    }));
    const entry = peer.getMap(TASKS_ROOT).get('c');
    expect(entry instanceof Y.Map && entry.has('segments')).toBe(true);
    expect(projectOf(peer).tasks.find((task) => task.id === 'c')).toEqual(summary('c'));
  });
});

describe('merging concurrent changes', () => {
  it('removes the dependency with the greatest identifier of a cycle', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => ({ ...current, dependencies: [...current.dependencies, link('c', 'm')] }),
      (current) => ({ ...current, dependencies: [...current.dependencies, link('m', 'c')] }),
    );
    expect(result.repairs).toEqual([{ code: 'DEPENDENCY_REMOVED', id: 'm-c' }]);
    expect(result.project.dependencies.map((dependency) => dependency.id).sort()).toEqual([
      'a-b',
      'b-m',
      'c-m',
    ]);
  });

  it('moves to the root the task with the smallest identifier of a hierarchy loop', () => {
    const base = project([summary('p'), summary('q')]);
    const result = mergeConcurrent(
      base,
      (current) => mapTask(current, 'p', (task) => ({ ...task, parentId: 'q' })),
      (current) => mapTask(current, 'q', (task) => ({ ...task, parentId: 'p' })),
    );
    expect(result.repairs).toEqual([{ code: 'MOVED_TO_ROOT', id: 'p' }]);
    expect(byId(result.project.tasks).map((task) => task.parentId)).toEqual([null, 'p']);
  });

  it('clears a tag deleted while it was being assigned', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => ({ ...current, tags: [DESIGN] }),
      (current) => mapTask(current, 'c', (task) => ({ ...task, tagId: 'alice' })),
    );
    expect(result.repairs).toEqual([{ code: 'TAG_CLEARED', id: 'c' }]);
  });

  it('moves to the root a task placed under a summary deleted at the same time', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => ({
        ...current,
        tasks: current.tasks
          .filter((task) => task.id !== 's2')
          .map((task) => (task.parentId === 's2' ? { ...task, parentId: null } : task)),
      }),
      (current) => mapTask(current, 'c', (task) => ({ ...task, parentId: 's2' })),
    );
    expect(result.repairs).toEqual([{ code: 'MOVED_TO_ROOT', id: 'c' }]);
  });

  it('fits hours per day to a working day shortened at the same time', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => ({
        ...current,
        calendar: { ...current.calendar, workingTimeRanges: MORNING_ONLY },
      }),
      (current) => mapTask(current, 'c', (task) => ({ ...task, hoursPerDay: 6 })),
    );
    expect(result.repairs).toEqual([{ code: 'HOURS_PER_DAY_REDUCED', id: 'c' }]);
  });

  it('rounds the progress of a task that became a milestone while its progress changed', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => mapTask(current, 'c', () => milestone('c')),
      (current) => mapTask(current, 'c', (task) => ({ ...task, progressPercent: 70 })),
    );
    expect(result.repairs).toEqual([{ code: 'MILESTONE_PROGRESS_ROUNDED', id: 'c' }]);
    expect(result.project.tasks.find((task) => task.id === 'c')).toEqual(
      milestone('c', { progressPercent: 100 }),
    );
  });

  it('removes a dependency added to a task that became a summary at the same time', () => {
    const result = mergeConcurrent(
      BASE_PROJECT,
      (current) => mapTask(current, 'c', () => summary('c')),
      (current) => ({ ...current, dependencies: [...current.dependencies, link('c', 'm')] }),
    );
    expect(result.repairs).toEqual([{ code: 'DEPENDENCY_REMOVED', id: 'c-m' }]);
  });
});

describe('merging untrusted updates', () => {
  it('refuses bytes that are not an update and leaves the document untouched', () => {
    const [peer] = createPeers(BASE_PROJECT, 1);
    if (peer === undefined) {
      throw new Error('Missing participant');
    }
    const before = Y.encodeStateAsUpdate(peer);
    expect(mergeSharedUpdate(peer, new Uint8Array([255, 255, 255, 255, 1, 2, 3]))).toEqual({
      ok: false,
      error: { kind: 'malformedUpdate' },
    });
    expect(Y.encodeStateAsUpdate(peer)).toEqual(before);
  });

  it('refuses an update carrying an invalid value and leaves the document untouched', () => {
    const [honest, malicious] = createPeers(BASE_PROJECT, 2);
    if (honest === undefined || malicious === undefined) {
      throw new Error('Missing participant');
    }
    const entry = malicious.getMap(TASKS_ROOT).get('c');
    if (!(entry instanceof Y.Map)) {
      throw new Error('Missing task');
    }
    entry.set('progressPercent', 500);
    const before = Y.encodeStateAsUpdate(honest);
    const merged = mergeSharedUpdate(
      honest,
      Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(honest)),
    );
    expect(merged.ok || merged.error.kind).toBe('invalidProject');
    expect(Y.encodeStateAsUpdate(honest)).toEqual(before);
  });

  it('accepts the same update twice and holds back an update that arrives before the one it depends on', () => {
    const [left, right] = createPeers(BASE_PROJECT, 2);
    if (left === undefined || right === undefined) {
      throw new Error('Missing participant');
    }
    const stateBefore = Y.encodeStateVector(left);
    change(left, (current) => ({ ...current, name: 'First' }));
    const first = Y.encodeStateAsUpdate(left, stateBefore);
    const stateBetween = Y.encodeStateVector(left);
    change(left, (current) => ({ ...current, name: 'Second' }));
    const second = Y.encodeStateAsUpdate(left, stateBetween);
    const before = Y.encodeStateAsUpdate(right);
    expect(mergeSharedUpdate(right, second)).toEqual({
      ok: false,
      error: { kind: 'incompleteUpdate' },
    });
    expect(Y.encodeStateAsUpdate(right)).toEqual(before);
    expect(mergeSharedUpdate(right, Y.mergeUpdates([second, first])).ok).toBe(true);
    expect(mergeSharedUpdate(right, first).ok).toBe(true);
    expect(mergeSharedUpdate(right, second).ok).toBe(true);
    expect(projectOf(right).name).toBe('Second');
  });

  it('repairs nothing on a valid document', () => {
    expect(repairSharedDocument(createSharedDocument(BASE_PROJECT))).toEqual({
      ok: true,
      value: [],
    });
  });
});

type Operation =
  | {
      readonly type: 'addLink';
      readonly from: number;
      readonly to: number;
      readonly kind: DependencyType;
    }
  | { readonly type: 'removeLink'; readonly index: number }
  | { readonly type: 'setParent'; readonly task: number; readonly parent: number | null }
  | { readonly type: 'setKind'; readonly task: number; readonly kind: Task['kind'] }
  | { readonly type: 'addTask'; readonly parent: number | null }
  | { readonly type: 'deleteTask'; readonly task: number }
  | { readonly type: 'setTag'; readonly task: number; readonly tag: number | null }
  | { readonly type: 'deleteTag'; readonly tag: number }
  | { readonly type: 'setDay'; readonly fullDay: boolean }
  | {
      readonly type: 'setHours';
      readonly task: number;
      readonly hours: number | null;
      readonly start: number | null;
    }
  | { readonly type: 'setProgress'; readonly task: number; readonly progress: number };

type Step =
  | { readonly type: 'edit'; readonly peer: number; readonly operation: Operation }
  | { readonly type: 'sync'; readonly from: number; readonly to: number }
  | { readonly type: 'replay'; readonly update: number; readonly to: number };

const index = fc.nat({ max: 20 });
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    type: fc.constant('addLink' as const),
    from: index,
    to: index,
    kind: fc.constantFrom<DependencyType>(
      'finishToStart',
      'startToStart',
      'finishToFinish',
      'startToFinish',
    ),
  }),
  fc.record({ type: fc.constant('removeLink' as const), index }),
  fc.record({ type: fc.constant('setParent' as const), task: index, parent: fc.option(index) }),
  fc.record({
    type: fc.constant('setKind' as const),
    task: index,
    kind: fc.constantFrom<Task['kind']>('task', 'milestone', 'summary'),
  }),
  fc.record({ type: fc.constant('addTask' as const), parent: fc.option(index) }),
  fc.record({ type: fc.constant('deleteTask' as const), task: index }),
  fc.record({
    type: fc.constant('setTag' as const),
    task: index,
    tag: fc.option(fc.nat({ max: 1 })),
  }),
  fc.record({ type: fc.constant('deleteTag' as const), tag: fc.nat({ max: 1 }) }),
  fc.record({ type: fc.constant('setDay' as const), fullDay: fc.boolean() }),
  fc.record({
    type: fc.constant('setHours' as const),
    task: index,
    hours: fc.option(fc.integer({ min: 1, max: 12 })),
    start: fc.option(fc.integer({ min: 0, max: 23 })),
  }),
  fc.record({
    type: fc.constant('setProgress' as const),
    task: index,
    progress: fc.integer({ min: 0, max: 100 }),
  }),
);

/** Builds the steps of a random session between a number of participants. */
function stepArbitrary(peerCount: number): fc.Arbitrary<Step> {
  const peer = fc.nat({ max: peerCount - 1 });
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        type: fc.constant('edit' as const),
        peer,
        operation: operationArbitrary,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ type: fc.constant('sync' as const), from: peer, to: peer }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ type: fc.constant('replay' as const), update: fc.nat(), to: peer }),
    },
  );
}

/** Converts a task to another kind, as the interface would, keeping its identifier, name, parent and order. */
function convert(task: Task, kind: Task['kind']): Task {
  const common = { name: task.name, parentId: task.parentId, sortKey: task.sortKey };
  const dated = task.kind === 'summary' ? {} : { tagId: task.tagId };
  if (kind === 'summary') {
    return summary(task.id, common);
  }
  if (kind === 'milestone') {
    return milestone(task.id, { ...common, ...dated });
  }
  return workTask(task.id, { ...common, ...dated });
}

/** Turns a random operation into a local change, the way the interface would perform it. */
function toChange(operation: Operation, newId: string): (current: Project) => Project {
  return (current) => {
    const tasks = byId(current.tasks);
    const pick = (position: number): Task | undefined =>
      tasks[position % Math.max(tasks.length, 1)];
    const tagId = (position: number | null): string | null =>
      position === null ? null : (byId(current.tags)[position]?.id ?? null);
    switch (operation.type) {
      case 'addLink': {
        const from = pick(operation.from);
        const to = pick(operation.to);
        return from === undefined || to === undefined
          ? current
          : {
              ...current,
              dependencies: [
                ...current.dependencies,
                { ...link(from.id, to.id, operation.kind), id: newId },
              ],
            };
      }
      case 'removeLink':
        return {
          ...current,
          dependencies: byId(current.dependencies).filter(
            (_item, position) => position !== operation.index,
          ),
        };
      case 'setParent': {
        const task = pick(operation.task);
        const parent = operation.parent === null ? undefined : pick(operation.parent);
        return task === undefined
          ? current
          : mapTask(current, task.id, (item) => ({ ...item, parentId: parent?.id ?? null }));
      }
      case 'setKind':
        return convertTask(current, pick(operation.task), operation.kind);
      case 'addTask':
        return {
          ...current,
          tasks: [
            ...current.tasks,
            workTask(newId, {
              parentId: operation.parent === null ? null : (pick(operation.parent)?.id ?? null),
            }),
          ],
        };
      case 'deleteTask':
        return deleteTask(current, pick(operation.task)?.id);
      case 'setTag': {
        const task = pick(operation.task);
        return task === undefined || task.kind === 'summary'
          ? current
          : mapTask(current, task.id, () => ({ ...task, tagId: tagId(operation.tag) }));
      }
      case 'deleteTag': {
        const removed = tagId(operation.tag);
        return {
          ...current,
          tags: current.tags.filter((tag) => tag.id !== removed),
          tasks: current.tasks.map((task) =>
            task.kind !== 'summary' && task.tagId === removed ? { ...task, tagId: null } : task,
          ),
        };
      }
      case 'setDay':
        return {
          ...current,
          calendar: {
            ...current.calendar,
            workingTimeRanges: operation.fullDay ? FULL_DAY : MORNING_ONLY,
          },
        };
      case 'setHours': {
        const task = pick(operation.task);
        return task?.kind === 'task'
          ? mapTask(current, task.id, () => ({
              ...task,
              hoursPerDay: operation.hours,
              dailyStartHour: operation.start,
            }))
          : current;
      }
      case 'setProgress': {
        const task = pick(operation.task);
        return task?.kind === 'task'
          ? mapTask(current, task.id, () => ({ ...task, progressPercent: operation.progress }))
          : current;
      }
    }
  };
}

/** Converts a task to another kind, removing its dependencies when it becomes a summary and freeing its children otherwise. */
function convertTask(current: Project, task: Task | undefined, kind: Task['kind']): Project {
  if (task === undefined) {
    return current;
  }
  const converted = mapTask(current, task.id, () => convert(task, kind));
  const dependencies =
    kind === 'summary'
      ? current.dependencies.filter(
          (item) => item.predecessorId !== task.id && item.successorId !== task.id,
        )
      : current.dependencies;
  const tasks = converted.tasks.map((item) =>
    kind !== 'summary' && item.parentId === task.id ? { ...item, parentId: null } : item,
  );
  return { ...converted, tasks, dependencies };
}

/** Deletes a task with its dependencies, moving its children to the root. */
function deleteTask(current: Project, id: string | undefined): Project {
  return {
    ...current,
    tasks: current.tasks
      .filter((task) => task.id !== id)
      .map((task) => (task.parentId === id ? { ...task, parentId: null } : task)),
    dependencies: current.dependencies.filter(
      (item) => item.predecessorId !== id && item.successorId !== id,
    ),
  };
}

describe('collaboration properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('ends in the same valid project for every participant after random edits and merges', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 4 })
          .chain((peerCount) =>
            fc.tuple(fc.constant(peerCount), fc.array(stepArbitrary(peerCount), { maxLength: 40 })),
          ),
        ([peerCount, steps]) => {
          const peers = createPeers(BASE_PROJECT, peerCount);
          const updates: Uint8Array[] = [];
          steps.forEach((step, position) => {
            if (step.type === 'edit') {
              const peer = peers[step.peer];
              if (peer !== undefined) {
                applySharedChange(
                  peer,
                  toChange(step.operation, `n${String(step.peer)}x${String(position)}`),
                );
              }
              return;
            }
            const to = peers[step.to];
            const from = step.type === 'sync' ? peers[step.from] : undefined;
            const update =
              from === undefined || to === undefined
                ? updates[step.type === 'replay' ? step.update % Math.max(updates.length, 1) : 0]
                : Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
            if (to !== undefined && update !== undefined) {
              updates.push(update);
              const merged = mergeSharedUpdate(to, update);
              if (step.type === 'sync') {
                expect(merged.ok).toBe(true);
              }
              expect(merged.ok || merged.error.kind).not.toBe('malformedUpdate');
            }
          });
          syncAll(peers);
          const [first, ...others] = peers.map((peer) => readSharedData(peer));
          others.forEach((data) => {
            expect(data).toEqual(first);
          });
          peers.forEach((peer) => {
            expect(readSharedProject(peer).ok).toBe(true);
            expect(repairSharedDocument(peer)).toEqual({ ok: true, value: [] });
          });
        },
      ),
    );
  });
});
