import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { Project } from '../model/project';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { createSharedDocument } from './shared-document';
import { readSharedProject } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const BASE: Project = project([workTask('a'), workTask('b'), workTask('c')], [link('a', 'b')]);

/** Opens sessions on participants sharing a project, each with a fixed client identifier. */
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

/** Opens one session on a project. */
function openOne(base: Project): SharedSession {
  const [session] = openSessions(base, 1);
  if (session === undefined) {
    throw new Error('No session');
  }
  return session;
}

/** Sends what one participant has and the other lacks. */
function sync(from: SharedSession, to: SharedSession): void {
  const update = Y.encodeStateAsUpdate(from.document, Y.encodeStateVector(to.document));
  expect(to.merge(update).ok).toBe(true);
}

/** Checks that the indexed project of a session matches its document. */
function expectConsistent(session: SharedSession): void {
  const read = readSharedProject(session.document);
  expect(read.ok && read.value).toEqual(session.project());
}

/** Renames the project of a session. */
function rename(session: SharedSession, name: string): void {
  expect(session.apply({ type: 'updateProject', fields: { name } }).ok).toBe(true);
}

describe('session history', () => {
  it('undoes and redoes local changes one at a time', () => {
    const session = openOne(BASE);
    expect(session.history.canUndo()).toBe(false);
    rename(session, 'First');
    rename(session, 'Second');
    expect(session.history.undo()).toEqual({ ok: true, value: [] });
    expect(session.project().name).toBe('First');
    expect(session.history.canRedo()).toBe(true);
    session.history.undo();
    expect(session.project()).toEqual(BASE);
    expect(session.history.canUndo()).toBe(false);
    session.history.redo();
    expect(session.project().name).toBe('First');
    expectConsistent(session);
  });

  it('does nothing when there is nothing to undo or redo', () => {
    const session = openOne(BASE);
    expect(session.history.undo()).toEqual({ ok: true, value: [] });
    expect(session.history.redo()).toEqual({ ok: true, value: [] });
    expect(session.project()).toEqual(BASE);
  });

  it('never undoes the changes of other participants', () => {
    const [alice, bob] = openSessions(BASE, 2);
    if (alice === undefined || bob === undefined) {
      throw new Error('No sessions');
    }
    rename(alice, 'Alice');
    sync(alice, bob);
    expect(bob.apply({ type: 'removeTasks', ids: ['c'] }).ok).toBe(true);
    sync(bob, alice);
    alice.history.undo();
    expect(alice.project().name).toBe(BASE.name);
    expect(alice.project().tasks.map((task) => task.id)).toEqual(['a', 'b']);
    expect(alice.history.canUndo()).toBe(false);
    expectConsistent(alice);
  });

  it('repairs an undone step that the changes of others made invalid, and can be followed by others', () => {
    const [alice, bob] = openSessions(BASE, 2);
    if (alice === undefined || bob === undefined) {
      throw new Error('No sessions');
    }
    const removed = BASE.dependencies[0];
    expect(removed && alice.apply({ type: 'removeDependency', id: removed.id }).ok).toBe(true);
    sync(alice, bob);
    const reverse = { ...link('b', 'a'), id: 'z-reverse' };
    expect(bob.apply({ type: 'putDependency', dependency: reverse }).ok).toBe(true);
    sync(bob, alice);
    const undone = alice.history.undo();
    expect(undone.ok && undone.value.length).toBe(1);
    const kept = alice.project().dependencies;
    expect(kept).toHaveLength(1);
    expectConsistent(alice);
    sync(alice, bob);
    expect(bob.project()).toEqual(alice.project());
  });

  it('comes back to the opened project after undoing every local change', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 8 }),
        (names) => {
          const session = openOne(BASE);
          names.forEach((name) => {
            session.apply({ type: 'updateProject', fields: { name } });
          });
          while (session.history.canUndo()) {
            expect(session.history.undo().ok).toBe(true);
          }
          expect(session.project()).toEqual(BASE);
          expectConsistent(session);
        },
      ),
    );
  });
});
