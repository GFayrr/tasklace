import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Dependency, Project, WorkTask } from '../model/project';
import {
  blockLink,
  project,
  splitTask,
  TEST_DOCUMENT_ID,
  workTask,
} from '../testing/project-builder';
import { createSharedDocument, DEPENDENCIES_ROOT, TASKS_ROOT } from './shared-document';
import type { SharedRepair } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const DEVELOPMENT = splitTask('dev', [
  [7, 0],
  [7, 0],
]);
const ONE_BLOCK: WorkTask = {
  ...DEVELOPMENT,
  segments: [{ durationHours: 14, gapDaysBefore: 0, startNoEarlierThan: null }],
};
const BASE: Project = project([DEVELOPMENT, workTask('test'), workTask('a')]);

/** Opens two participants on the same project. */
function openPair(base: Project = BASE): readonly [SharedSession, SharedSession] {
  const origin = createSharedDocument(base, TEST_DOCUMENT_ID);
  const open = (clientId: number): SharedSession => {
    const document = new Y.Doc();
    document.clientID = clientId;
    Y.applyUpdate(document, Y.encodeStateAsUpdate(origin));
    const session = openSharedSession(document);
    if (!session.ok) {
      throw new Error(JSON.stringify(session.error));
    }
    return session.value;
  };
  return [open(1), open(2)];
}

/** Sends to each participant what the other has and returns the repairs both reported. */
function syncBoth(left: SharedSession, right: SharedSession): readonly SharedRepair[] {
  const toLeft = left.merge(
    Y.encodeStateAsUpdate(right.document, Y.encodeStateVector(left.document)),
  );
  const toRight = right.merge(
    Y.encodeStateAsUpdate(left.document, Y.encodeStateVector(right.document)),
  );
  if (!toLeft.ok || !toRight.ok) {
    throw new Error('A merge was refused');
  }
  return [...toLeft.value, ...toRight.value];
}

/** Applies a link to a session, failing the test when it is refused. */
function linked(session: SharedSession, dependency: Dependency): void {
  expect(session.apply({ type: 'putDependency', dependency }).ok).toBe(true);
}

/** Leaves the split task of a session with one block, failing the test when it is refused. */
function unsplit(session: SharedSession): void {
  expect(session.apply({ type: 'putTask', task: ONE_BLOCK }).ok).toBe(true);
}

describe('block links edited at the same time', () => {
  it('points at the whole task a link from a block a collaborator removed meanwhile, and says so', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('dev', 'test', { from: 1 }));
    unsplit(bob);
    const repairs = syncBoth(alice, bob);
    expect(alice.project().dependencies).toEqual([
      { ...blockLink('dev', 'test', { from: 1 }), predecessorBlock: null },
    ]);
    expect(bob.project()).toEqual(alice.project());
    expect(repairs).toContainEqual({ code: 'BLOCK_LINK_CLEARED', id: 'dev_1-test' });
  });

  it('points at the whole task a link to a block a collaborator removed meanwhile', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('test', 'dev', { to: 1 }));
    unsplit(bob);
    const repairs = syncBoth(alice, bob);
    expect(alice.project().dependencies).toEqual([
      { ...blockLink('test', 'dev', { to: 1 }), successorBlock: null },
    ]);
    expect(bob.project()).toEqual(alice.project());
    expect(repairs).toContainEqual({ code: 'BLOCK_LINK_CLEARED', id: 'test-dev_1' });
  });

  it('keeps the link with the smallest identifier when two block links become the same', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('a', 'dev', { to: 1 }, 'finishToFinish'));
    linked(alice, blockLink('a', 'dev', {}, 'startToStart'));
    unsplit(bob);
    const repairs = syncBoth(alice, bob);
    expect(alice.project().dependencies.map((dependency) => dependency.id)).toEqual(['a-dev']);
    expect(bob.project()).toEqual(alice.project());
    expect(repairs).toContainEqual({ code: 'DEPENDENCY_REMOVED', id: 'a-dev_1' });
  });

  it('breaks the loop that pointing two block links at the whole task creates, the same way for both', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('dev', 'test', { from: 0 }));
    linked(alice, blockLink('test', 'dev', { to: 1 }));
    unsplit(bob);
    const repairs = syncBoth(alice, bob);
    expect(alice.project().dependencies.map((dependency) => dependency.id)).toEqual(['dev_0-test']);
    expect(bob.project()).toEqual(alice.project());
    expect(repairs).toEqual([
      { code: 'BLOCK_LINK_CLEARED', id: 'dev_0-test' },
      { code: 'BLOCK_LINK_CLEARED', id: 'test-dev_1' },
      { code: 'DEPENDENCY_REMOVED', id: 'test-dev_1' },
    ]);
  });

  it('breaks a loop made through the blocks by two collaborators, the same way for both', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('dev', 'test', { from: 1 }));
    linked(bob, blockLink('test', 'dev', { to: 0 }));
    syncBoth(alice, bob);
    expect(alice.project().dependencies.map((dependency) => dependency.id)).toEqual(['dev_1-test']);
    expect(bob.project()).toEqual(alice.project());
  });

  it('keeps both links when they only look like a loop between whole tasks', () => {
    const [alice, bob] = openPair();
    linked(alice, blockLink('dev', 'test', { from: 0 }));
    linked(bob, blockLink('test', 'dev', { to: 1 }));
    syncBoth(alice, bob);
    expect(alice.project().dependencies).toHaveLength(2);
  });
});

describe('block links checked on a local change', () => {
  it('refuses to leave one block to a task whose links would then make a loop', () => {
    const [alice] = openPair(
      project(
        [DEVELOPMENT, workTask('test')],
        [
          blockLink('dev', 'test', {}, 'startToStart'),
          blockLink('test', 'dev', {}, 'finishToFinish'),
        ],
      ),
    );
    const before = alice.project();
    const refused = alice.apply({ type: 'putTask', task: ONE_BLOCK });
    expect(refused).toEqual({
      ok: false,
      error: [{ path: 'tasks.dev', code: 'DEPENDENCY_CYCLE' }],
    });
    expect(alice.project()).toEqual(before);
  });

  it('refuses to remove a block that a link names', () => {
    const [alice] = openPair(
      project([DEVELOPMENT, workTask('test')], [blockLink('dev', 'test', { from: 1 })]),
    );
    const refused = alice.apply({ type: 'putTask', task: ONE_BLOCK });
    expect(refused).toEqual({ ok: false, error: [{ path: 'tasks.dev', code: 'UNKNOWN_BLOCK' }] });
  });

  it('refuses a link to a block of a task that is not split', () => {
    const [alice] = openPair();
    const refused = alice.apply({
      type: 'putDependency',
      dependency: blockLink('dev', 'test', { to: 0 }),
    });
    expect(refused).toEqual({
      ok: false,
      error: [{ path: 'dependencies.dev-test_0', code: 'UNKNOWN_BLOCK' }],
    });
  });

  it('refuses a received link whose block number is not a valid number, leaving the project intact', () => {
    const [alice, bob] = openPair();
    linked(bob, blockLink('dev', 'test', { from: 1 }));
    const update = Y.encodeStateAsUpdate(bob.document, Y.encodeStateVector(alice.document));
    const tampered = new Y.Doc();
    Y.applyUpdate(tampered, Y.encodeStateAsUpdate(bob.document));
    tampered.clientID = 3;
    const entry = tampered.getMap(DEPENDENCIES_ROOT).get('dev_1-test');
    if (!(entry instanceof Y.Map)) {
      throw new Error('Missing link entry');
    }
    entry.set('predecessorBlock', -1);
    const before = alice.project();
    const forged = Y.mergeUpdates([
      update,
      Y.encodeStateAsUpdate(tampered, Y.encodeStateVector(bob.document)),
    ]);
    const merged = alice.merge(forged);
    expect(merged).toEqual({
      ok: false,
      error: {
        kind: 'invalidProject',
        issues: [{ path: 'dependencies[0].predecessorBlock', code: 'OUT_OF_RANGE' }],
      },
    });
    expect(alice.project()).toEqual(before);
  });

  it('refuses a received start date on the first block of a task, leaving the project intact', () => {
    const [alice, bob] = openPair();
    const tampered = new Y.Doc();
    Y.applyUpdate(tampered, Y.encodeStateAsUpdate(bob.document));
    tampered.clientID = 3;
    const entry = tampered.getMap(TASKS_ROOT).get('dev');
    if (!(entry instanceof Y.Map)) {
      throw new Error('Missing task entry');
    }
    entry.set('segments', [
      { durationHours: 7, gapDaysBefore: 0, startNoEarlierThan: 100 },
      { durationHours: 7, gapDaysBefore: 0, startNoEarlierThan: null },
    ]);
    const before = alice.project();
    const merged = alice.merge(
      Y.encodeStateAsUpdate(tampered, Y.encodeStateVector(alice.document)),
    );
    expect(merged.ok).toBe(false);
    expect(!merged.ok && merged.error.kind).toBe('invalidProject');
    expect(alice.project()).toEqual(before);
  });
});
