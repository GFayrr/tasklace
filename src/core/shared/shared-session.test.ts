import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { compareStrings } from '../compare-strings';
import { MAX_HIERARCHY_DEPTH, MAX_TAGS } from '../limits';
import type { DependencyType, Project, Tag, Task } from '../model/project';
import { CONVERGENCE_TEST_TIMEOUT_MS, PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { hideListContent } from '../testing/hidden-list-content';
import {
  link,
  milestone,
  project,
  summary,
  workTask,
  TEST_DOCUMENT_ID,
} from '../testing/project-builder';
import { createSharedDocument, readSharedData, TASKS_ROOT } from './shared-document';
import { applyOperation, taskOfCalendarIssue, type SharedOperation } from './shared-operations';
import { applySharedChange, mergeSharedUpdate, readSharedProject } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

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

/** Opens sessions on participants sharing the same project, each with a fixed client identifier. */
function openSessions(base: Project, count: number): SharedSession[] {
  const origin = createSharedDocument(base, TEST_DOCUMENT_ID);
  return Array.from({ length: count }, (_unused, index) => {
    const document = new Y.Doc();
    document.clientID = index + 1;
    Y.applyUpdate(document, Y.encodeStateAsUpdate(origin));
    const session = openSharedSession(document);
    if (!session.ok) {
      throw new Error(JSON.stringify(session.error));
    }
    return session.value;
  });
}

/** Copies a document so that the reference functions can be run on the same content. */
function copyOf(document: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  return copy;
}

/** Checks that a session's indexed project matches its document. */
function expectConsistent(session: SharedSession): void {
  const read = readSharedProject(session.document);
  expect(read.ok).toBe(true);
  expect(read.ok && read.value).toEqual(session.project());
}

/** Applies an operation to a session and, on a copy, through the reference, checking that both agree. */
function applyBoth(session: SharedSession, operation: SharedOperation): boolean {
  const reference = copyOf(session.document);
  const expected = applySharedChange(reference, (current) => applyOperation(current, operation));
  const result = session.apply(operation);
  expect(result.ok).toBe(expected.ok);
  expect(readSharedData(session.document)).toEqual(readSharedData(reference));
  expectConsistent(session);
  return result.ok;
}

/** Returns the shared entry of a task, failing the test when it is missing. */
function entryOf(document: Y.Doc, id: string): Y.Map<unknown> {
  const entry = document.getMap(TASKS_ROOT).get(id);
  if (!(entry instanceof Y.Map)) {
    throw new Error(`Missing task ${id}`);
  }
  return entry;
}

/** Merges an update into a session and, on a copy, through the reference, checking that both agree. */
function mergeBoth(session: SharedSession, update: Uint8Array): boolean {
  const reference = copyOf(session.document);
  const expected = mergeSharedUpdate(reference, update);
  const result = session.merge(update);
  expect(result.ok || result.error.kind).toEqual(expected.ok || expected.error.kind);
  if (result.ok && expected.ok) {
    expect([...result.value].sort(compareRepairs)).toEqual(
      [...expected.value].sort(compareRepairs),
    );
  }
  expect(readSharedData(session.document)).toEqual(readSharedData(reference));
  expectConsistent(session);
  return result.ok && result.value.length > 0;
}

/** Orders repairs by code then identifier. */
function compareRepairs(
  left: { code: string; id: string },
  right: { code: string; id: string },
): number {
  return compareStrings(left.code, right.code) || compareStrings(left.id, right.id);
}

/** Sends to a session everything it is missing from another one, through both implementations. */
function syncBoth(from: SharedSession, to: SharedSession): boolean {
  return mergeBoth(to, Y.encodeStateAsUpdate(from.document, Y.encodeStateVector(to.document)));
}

describe('shared session', () => {
  it('opens only on a valid document and gives back its project', () => {
    const [session] = openSessions(BASE_PROJECT, 1);
    expect(session?.project()).toEqual(
      readSharedProject(session?.document ?? new Y.Doc()).ok && session?.project(),
    );
    const broken = createSharedDocument(BASE_PROJECT, TEST_DOCUMENT_ID);
    broken.getMap(TASKS_ROOT).set('z', 'not a task');
    expect(openSharedSession(broken).ok).toBe(false);
  });

  it('never keeps a reference to a missing tag, from the opening on', () => {
    const imported = createSharedDocument(
      {
        ...BASE_PROJECT,
        tasks: [...BASE_PROJECT.tasks, workTask('lost', { tagId: 'deleted' })],
      },
      TEST_DOCUMENT_ID,
    );
    const session = openSharedSession(imported);
    expect(session.ok && session.value.openingRepairs).toEqual([
      { code: 'TAG_CLEARED', id: 'lost' },
    ]);
    expect(
      session.ok && session.value.project().tasks.find((task) => task.id === 'lost'),
    ).toMatchObject({
      tagId: null,
    });
    expect(readSharedProject(imported).ok && readSharedProject(imported)).toMatchObject({
      ok: true,
    });
    if (!session.ok) {
      throw new Error('Missing session');
    }
    expect(
      applyBoth(session.value, { type: 'putTask', task: workTask('c', { tagId: 'unknown' }) }),
    ).toBe(true);
    expect(session.value.project().tasks.find((task) => task.id === 'c')).toMatchObject({
      tagId: null,
    });
  });

  it('writes only what an operation touches', () => {
    const [session] = openSessions(BASE_PROJECT, 1);
    if (session === undefined) {
      throw new Error('Missing session');
    }
    const updates: Uint8Array[] = [];
    session.document.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    expect(session.apply({ type: 'putTask', task: workTask('c', { name: 'Renamed' }) }).ok).toBe(
      true,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.length).toBeLessThan(80);
  });

  it.each<[string, SharedOperation]>([
    ['a cycle', { type: 'putDependency', dependency: link('m', 'a') }],
    ['a summary dependency', { type: 'putDependency', dependency: link('s1', 'c') }],
    ['a duplicate pair', { type: 'putDependency', dependency: { ...link('a', 'b'), id: 'again' } }],
    ['a dependency to nothing', { type: 'putDependency', dependency: link('a', 'gone') }],
    ['a parent that is not a summary', { type: 'putTask', task: workTask('c', { parentId: 'a' }) }],
    ['a loop in the tree', { type: 'putTask', task: summary('s1', { parentId: 's2' }) }],
    ['a summary with dependencies', { type: 'putTask', task: summary('a', { parentId: 's1' }) }],
    ['a task with children', { type: 'putTask', task: workTask('s2', { parentId: 's1' }) }],
    ['too many hours per day', { type: 'putTask', task: workTask('c', { hoursPerDay: 9 }) }],
    ['an invalid field', { type: 'putTask', task: workTask('c', { progressPercent: 101 }) }],
    ['a partial milestone', { type: 'putTask', task: milestone('m', { progressPercent: 40 }) }],
    ['removing a parent alone', { type: 'removeTasks', ids: ['s2'] }],
    [
      'a calendar too short for a task',
      {
        type: 'updateProject',
        fields: {
          calendar: {
            ...BASE_PROJECT.calendar,
            workingTimeRanges: [{ startHour: 9, endHour: 10 }],
          },
        },
      },
    ],
  ])('refuses %s exactly like the full validation', (_label, operation) => {
    const [session] = openSessions(
      {
        ...BASE_PROJECT,
        tasks: BASE_PROJECT.tasks.map((task) =>
          task.id === 'c' ? workTask('c', { hoursPerDay: 3 }) : task,
        ),
      },
      1,
    );
    if (session === undefined) {
      throw new Error('Missing session');
    }
    expect(applyBoth(session, operation)).toBe(false);
  });

  it('removes tasks with their dependencies and a tag from the tasks using it', () => {
    const [session] = openSessions(BASE_PROJECT, 1);
    if (session === undefined) {
      throw new Error('Missing session');
    }
    expect(applyBoth(session, { type: 'removeTasks', ids: ['s2', 'b'] })).toBe(true);
    expect(applyBoth(session, { type: 'removeTag', id: 'design' })).toBe(true);
    expect(session.project().dependencies).toEqual([]);
    expect(session.project().tasks.find((task) => task.id === 'a')).toMatchObject({ tagId: null });
  });
});

describe('shared session edge cases', () => {
  /** Opens one session on a project, failing the test when it cannot be opened. */
  function openOne(base: Project = BASE_PROJECT): SharedSession {
    const [session] = openSessions(base, 1);
    if (session === undefined) {
      throw new Error('Missing session');
    }
    return session;
  }

  it.each<[string, SharedOperation]>([
    [
      'a dependency with an invalid lag',
      { type: 'putDependency', dependency: { ...link('c', 'm'), lagHours: 0.3 } },
    ],
    [
      'a tag with an invalid color',
      { type: 'putTag', tag: { ...DESIGN, id: 'red', color: 'red' } },
    ],
  ])('refuses %s with the location of the item', (_label, operation) => {
    const session = openOne();
    const result = session.apply(operation);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0].path).toMatch(/^(dependencies|tags)\.(c-m|red)\./);
    expect(applyBoth(openOne(), operation)).toBe(false);
  });

  it('refuses a tag beyond the limit', () => {
    const tags = Array.from({ length: MAX_TAGS }, (_unused, index) => ({
      ...DESIGN,
      id: `t${String(index)}`,
    }));
    const session = openOne({ ...BASE_PROJECT, tags: [...tags] });
    expect(applyBoth(session, { type: 'putTag', tag: { ...DESIGN, id: 'one-more' } })).toBe(false);
  });

  it('refuses to nest a tree deeper than the limit, even through the tasks under a moved summary', () => {
    const chain = Array.from({ length: MAX_HIERARCHY_DEPTH }, (_unused, index) =>
      summary(`d${String(index).padStart(2, '0')}`, {
        parentId: index === 0 ? null : `d${String(index - 1).padStart(2, '0')}`,
      }),
    );
    const session = openOne(
      project([...chain, summary('top'), summary('under', { parentId: 'top' })]),
    );
    expect(
      applyBoth(session, {
        type: 'putTask',
        task: workTask('leaf', { parentId: `d${String(MAX_HIERARCHY_DEPTH - 1)}` }),
      }),
    ).toBe(false);
    expect(
      applyBoth(session, {
        type: 'putTask',
        task: summary('top', { parentId: `d${String(MAX_HIERARCHY_DEPTH - 2)}` }),
      }),
    ).toBe(false);
  });

  it('keeps the previous version of a dependency when its replacement is refused', () => {
    const session = openOne();
    expect(
      applyBoth(session, {
        type: 'putDependency',
        dependency: { ...link('a', 'b'), predecessorId: 'b', successorId: 'm' },
      }),
    ).toBe(false);
    expect(session.project().dependencies.find((dependency) => dependency.id === 'a-b')).toEqual(
      link('a', 'b'),
    );
  });

  it('refuses bytes that are not an update and stays usable', () => {
    const session = openOne();
    const result = session.merge(new Uint8Array([255, 255, 255, 1, 2, 3]));
    expect(result.ok || result.error.kind).toBe('malformedUpdate');
    expect(applyBoth(session, { type: 'updateProject', fields: { name: 'Still fine' } })).toBe(
      true,
    );
  });

  it('refuses a tampered project field through the fast path, like the full check', () => {
    const [source, victim] = openSessions(BASE_PROJECT, 2);
    if (source === undefined || victim === undefined) {
      throw new Error('Missing session');
    }
    const malicious = copyOf(source.document);
    malicious.clientID = 77;
    malicious.getMap('project').set('name', 5);
    expect(
      mergeBoth(victim, Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(victim.document))),
    ).toBe(false);
  });

  it('knows its document identifier and refuses an update that changes it, through the fast path', () => {
    const [source, victim] = openSessions(BASE_PROJECT, 2);
    if (source === undefined || victim === undefined) {
      throw new Error('Missing session');
    }
    expect(victim.documentId).toBe(TEST_DOCUMENT_ID);
    const malicious = copyOf(source.document);
    malicious.clientID = 77;
    malicious.getMap('project').set('documentId', '00000000-0000-4000-8000-000000000002');
    const update = Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(victim.document));
    expect(victim.merge(update)).toEqual({
      ok: false,
      error: { kind: 'invalidProject', issues: [{ path: 'documentId', code: 'READ_ONLY_FIELD' }] },
    });
    expect(victim.document.getMap('project').get('documentId')).toBe(TEST_DOCUMENT_ID);
  });

  it('refuses to open a document without identifier', () => {
    const document = copyOf(createSharedDocument(BASE_PROJECT, TEST_DOCUMENT_ID));
    document.getMap('project').delete('documentId');
    expect(openSharedSession(document)).toEqual({
      ok: false,
      error: [{ path: 'documentId', code: 'MISSING_FIELD' }],
    });
  });

  it.each<[string, (malicious: Y.Doc) => Y.Map<unknown>]>([
    ['a root', (malicious) => malicious.getMap(TASKS_ROOT)],
    ['the project', (malicious) => malicious.getMap('project')],
    ['an entry', (malicious) => entryOf(malicious, 'a')],
  ])('refuses list content hidden in %s through the fast path', (_label, target) => {
    const [source, victim] = openSessions(BASE_PROJECT, 2);
    if (source === undefined || victim === undefined) {
      throw new Error('Missing session');
    }
    const malicious = copyOf(source.document);
    malicious.clientID = 77;
    hideListContent(target(malicious));
    const update = Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(victim.document));
    const before = readSharedData(victim.document);
    expect(victim.merge(update).ok).toBe(false);
    expect(readSharedData(victim.document)).toEqual(before);
  });

  it('names the task a shorter working day refuses, and no task for any other issue', () => {
    const opened = openSharedSession(
      createSharedDocument(project([workTask('long', { hoursPerDay: 6 })], []), TEST_DOCUMENT_ID),
    );
    if (!opened.ok) {
      throw new Error(JSON.stringify(opened.error));
    }
    const refused = opened.value.apply({
      type: 'updateProject',
      fields: { calendar: { ...BASE_PROJECT.calendar, workingTimeRanges: MORNING_ONLY } },
    });
    expect(refused).toEqual({
      ok: false,
      error: [{ path: 'tasks.long', code: 'INVALID_HOURS_PER_DAY' }],
    });
    expect(refused.ok ? null : refused.error.map(taskOfCalendarIssue)).toEqual(['long']);
    expect(
      taskOfCalendarIssue({ path: 'calendar.workingWeekdays', code: 'EMPTY_LIST' }),
    ).toBeNull();
  });

  it('rounds, clears and fits tasks in one fast merge, reporting repairs in order', () => {
    const [left, right] = openSessions(BASE_PROJECT, 2);
    if (left === undefined || right === undefined) {
      throw new Error('Missing session');
    }
    expect(applyBoth(left, { type: 'putTask', task: milestone('c') })).toBe(true);
    expect(
      applyBoth(left, {
        type: 'updateProject',
        fields: { calendar: { ...BASE_PROJECT.calendar, workingTimeRanges: MORNING_ONLY } },
      }),
    ).toBe(true);
    expect(
      applyBoth(right, { type: 'putTask', task: workTask('c', { progressPercent: 70 }) }),
    ).toBe(true);
    expect(
      applyBoth(right, {
        type: 'putTask',
        task: workTask('b', { parentId: 's2', hoursPerDay: 6, tagId: 'alice' }),
      }),
    ).toBe(true);
    expect(applyBoth(left, { type: 'removeTag', id: 'alice' })).toBe(true);
    expect(syncBoth(right, left)).toBe(true);
    syncBoth(left, right);
    expect(readSharedData(left.document)).toEqual(readSharedData(right.document));
  });
});

type OperationShape =
  | { readonly type: 'rename'; readonly task: number }
  | { readonly type: 'progress'; readonly task: number; readonly value: number }
  | {
      readonly type: 'hours';
      readonly task: number;
      readonly hours: number | null;
      readonly start: number | null;
    }
  | { readonly type: 'tag'; readonly task: number; readonly tag: string | null }
  | { readonly type: 'parent'; readonly task: number; readonly parent: number | null }
  | { readonly type: 'kind'; readonly task: number; readonly kind: Task['kind'] }
  | { readonly type: 'addTask'; readonly parent: number | null }
  | { readonly type: 'removeTask'; readonly task: number }
  | {
      readonly type: 'link';
      readonly from: number;
      readonly to: number;
      readonly kind: DependencyType;
      readonly fromBlock: number | null;
      readonly toBlock: number | null;
    }
  | { readonly type: 'blocks'; readonly task: number; readonly count: number }
  | { readonly type: 'unlink'; readonly index: number }
  | { readonly type: 'putTag'; readonly id: string }
  | { readonly type: 'removeTag'; readonly id: string }
  | { readonly type: 'day'; readonly fullDay: boolean }
  | { readonly type: 'name'; readonly name: string };

type Step =
  | { readonly type: 'edit'; readonly peer: number; readonly operation: OperationShape }
  | { readonly type: 'sync'; readonly from: number; readonly to: number }
  | { readonly type: 'replay'; readonly update: number; readonly to: number }
  | {
      readonly type: 'tamper';
      readonly from: number;
      readonly to: number;
      readonly key: string;
      readonly value: unknown;
    };

const position = fc.nat({ max: 20 });
const tagId = fc.constantFrom('design', 'alice', 'extra');
const operationArbitrary: fc.Arbitrary<OperationShape> = fc.oneof(
  fc.record({ type: fc.constant('rename' as const), task: position }),
  fc.record({
    type: fc.constant('progress' as const),
    task: position,
    value: fc.integer({ min: 0, max: 100 }),
  }),
  fc.record({
    type: fc.constant('hours' as const),
    task: position,
    hours: fc.option(fc.integer({ min: 1, max: 12 })),
    start: fc.option(fc.integer({ min: 0, max: 23 })),
  }),
  fc.record({ type: fc.constant('tag' as const), task: position, tag: fc.option(tagId) }),
  fc.record({ type: fc.constant('parent' as const), task: position, parent: fc.option(position) }),
  fc.record({
    type: fc.constant('kind' as const),
    task: position,
    kind: fc.constantFrom<Task['kind']>('task', 'milestone', 'summary'),
  }),
  fc.record({ type: fc.constant('addTask' as const), parent: fc.option(position) }),
  fc.record({ type: fc.constant('removeTask' as const), task: position }),
  fc.record({
    type: fc.constant('link' as const),
    from: position,
    to: position,
    kind: fc.constantFrom<DependencyType>(
      'finishToStart',
      'startToStart',
      'finishToFinish',
      'startToFinish',
    ),
    fromBlock: fc.option(fc.nat({ max: 2 })),
    toBlock: fc.option(fc.nat({ max: 2 })),
  }),
  fc.record({
    type: fc.constant('blocks' as const),
    task: position,
    count: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({ type: fc.constant('unlink' as const), index: position }),
  fc.record({ type: fc.constant('putTag' as const), id: tagId }),
  fc.record({ type: fc.constant('removeTag' as const), id: tagId }),
  fc.record({ type: fc.constant('day' as const), fullDay: fc.boolean() }),
  fc.record({ type: fc.constant('name' as const), name: fc.constantFrom('Plan', 'Projet', '') }),
);

/** Generates one random step of a session between a number of participants. */
function stepArbitrary(peerCount: number): fc.Arbitrary<Step> {
  const peer = fc.nat({ max: peerCount - 1 });
  return fc.oneof(
    {
      weight: 4,
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
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('tamper' as const),
        from: peer,
        to: peer,
        key: fc.constantFrom(
          'name',
          'progressPercent',
          'junk',
          'parentId',
          'hoursPerDay',
          'segments',
          'tagId',
        ),
        value: fc.jsonValue(),
      }),
    },
  );
}

/** Turns a random operation shape into a concrete operation on the current project. */
function toOperation(shape: OperationShape, current: Project, newId: string): SharedOperation {
  const tasks = current.tasks;
  /** Picks a task by a generated position, or nothing when there is no task. */
  const pick = (index: number): Task | undefined => tasks[index % Math.max(tasks.length, 1)];
  const task = 'task' in shape ? pick(shape.task) : undefined;
  switch (shape.type) {
    case 'rename':
      return task === undefined
        ? noOperation()
        : { type: 'putTask', task: { ...task, name: `${task.name}!` } };
    case 'progress':
      return task === undefined || task.kind === 'summary'
        ? noOperation()
        : { type: 'putTask', task: { ...task, progressPercent: shape.value } };
    case 'hours':
      return task?.kind === 'task'
        ? {
            type: 'putTask',
            task: { ...task, hoursPerDay: shape.hours, dailyStartHour: shape.start },
          }
        : noOperation();
    case 'tag':
      return task === undefined || task.kind === 'summary'
        ? noOperation()
        : { type: 'putTask', task: { ...task, tagId: shape.tag } };
    case 'parent':
      return task === undefined
        ? noOperation()
        : {
            type: 'putTask',
            task: {
              ...task,
              parentId: shape.parent === null ? null : (pick(shape.parent)?.id ?? null),
            },
          };
    case 'kind':
      return task === undefined
        ? noOperation()
        : { type: 'putTask', task: convert(task, shape.kind) };
    case 'addTask':
      return {
        type: 'putTask',
        task: workTask(newId, {
          parentId: shape.parent === null ? null : (pick(shape.parent)?.id ?? null),
        }),
      };
    case 'removeTask':
      return task === undefined ? noOperation() : { type: 'removeTasks', ids: [task.id] };
    case 'link': {
      const from = pick(shape.from);
      const to = pick(shape.to);
      return from === undefined || to === undefined
        ? noOperation()
        : {
            type: 'putDependency',
            dependency: {
              ...link(from.id, to.id, shape.kind),
              id: newId,
              predecessorBlock: shape.fromBlock,
              successorBlock: shape.toBlock,
            },
          };
    }
    case 'blocks':
      return task?.kind === 'task'
        ? {
            type: 'putTask',
            task: {
              ...task,
              segments: Array.from({ length: shape.count }, (_unused, index) => ({
                durationHours: 3,
                gapDaysBefore: index === 0 ? 0 : 1,
                startNoEarlierThan: null,
              })),
            },
          }
        : noOperation();
    case 'unlink':
      return {
        type: 'removeDependency',
        id:
          current.dependencies[shape.index % Math.max(current.dependencies.length, 1)]?.id ??
          'none',
      };
    case 'putTag':
      return { type: 'putTag', tag: { ...DESIGN, id: shape.id, name: shape.id } };
    case 'removeTag':
      return { type: 'removeTag', id: shape.id };
    case 'day':
      return {
        type: 'updateProject',
        fields: {
          calendar: {
            ...current.calendar,
            workingTimeRanges: shape.fullDay ? FULL_DAY : MORNING_ONLY,
          },
        },
      };
    case 'name':
      return { type: 'updateProject', fields: { name: shape.name } };
  }
}

/** Returns an operation that changes nothing. */
function noOperation(): SharedOperation {
  return { type: 'removeDependency', id: 'none' };
}

/** Converts a task to another kind, keeping its identifier, name, parent, order and tag. */
function convert(task: Task, kind: Task['kind']): Task {
  const common = { name: task.name, parentId: task.parentId, sortKey: task.sortKey };
  const dated = task.kind === 'summary' ? {} : { tagId: task.tagId };
  if (kind === 'summary') {
    return summary(task.id, common);
  }
  return kind === 'milestone'
    ? milestone(task.id, { ...common, ...dated })
    : workTask(task.id, { ...common, ...dated });
}

/** Builds a tampered update from a copy of a participant's document. */
function tamperedUpdate(
  from: Y.Doc,
  to: Y.Doc,
  key: string,
  value: unknown,
  clientId: number,
): Uint8Array {
  const malicious = copyOf(from);
  malicious.clientID = clientId;
  const [firstId] = [...malicious.getMap(TASKS_ROOT).keys()].sort(compareStrings);
  const entry = firstId === undefined ? undefined : malicious.getMap(TASKS_ROOT).get(firstId);
  if (entry instanceof Y.Map) {
    entry.set(key, value);
  }
  return Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(to));
}

/** Plays one step on the sessions, comparing every decision with the reference, and counts accepted edits and repaired merges. */
function playStep(
  sessions: readonly SharedSession[],
  updates: Uint8Array[],
  step: Step,
  index: number,
  counters: { edits: number; repairs: number },
): void {
  const to = sessions[step.type === 'edit' ? step.peer : step.to];
  if (to === undefined) {
    return;
  }
  if (step.type === 'edit') {
    counters.edits += applyBoth(
      to,
      toOperation(step.operation, to.project(), `n${String(step.peer)}x${String(index)}`),
    )
      ? 1
      : 0;
    return;
  }
  const from = step.type === 'replay' ? undefined : sessions[step.from];
  const update =
    step.type === 'replay'
      ? updates[step.update % Math.max(updates.length, 1)]
      : from === undefined
        ? undefined
        : step.type === 'sync'
          ? Y.encodeStateAsUpdate(from.document, Y.encodeStateVector(to.document))
          : tamperedUpdate(from.document, to.document, step.key, step.value, 1_000 + index);
  if (update !== undefined) {
    updates.push(update);
    counters.repairs += mergeBoth(to, update) ? 1 : 0;
  }
}

const CONVERGENCE_RUNS = 150;

describe('shared session properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it(
    'takes exactly the decisions of the full validation and repair, and converges',
    {
      timeout: CONVERGENCE_TEST_TIMEOUT_MS,
    },
    () => {
      const counters = { edits: 0, repairs: 0 };
      fc.assert(
        fc.property(
          fc
            .integer({ min: 2, max: 3 })
            .chain((peerCount) =>
              fc.tuple(
                fc.constant(peerCount),
                fc.array(stepArbitrary(peerCount), { minLength: 15, maxLength: 35 }),
              ),
            ),
          ([peerCount, steps]) => {
            const sessions = openSessions(BASE_PROJECT, peerCount);
            const updates: Uint8Array[] = [];
            steps.forEach((step, index) => {
              playStep(sessions, updates, step, index, counters);
            });
            for (let round = 0; round <= peerCount; round += 1) {
              for (const [from, to] of sessions.flatMap((left) =>
                sessions.filter((right) => right !== left).map((right) => [left, right] as const),
              )) {
                counters.repairs += syncBoth(from, to) ? 1 : 0;
              }
            }
            const [first, ...others] = sessions.map((session) => readSharedData(session.document));
            others.forEach((data) => {
              expect(data).toEqual(first);
            });
          },
        ),
        { numRuns: CONVERGENCE_RUNS },
      );
      expect(counters.edits).toBeGreaterThan(0);
      expect(counters.repairs).toBeGreaterThan(0);
    },
  );
});
