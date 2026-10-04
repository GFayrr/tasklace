import { describe, expect, it, vi } from 'vitest';
import { link, milestone, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import * as Y from 'yjs';
import type { Project, Tag } from '../model/project';
import { createSharedDocument } from './shared-document';
import type { SharedOperation } from './shared-operations';
import { mergeSharedUpdate } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

vi.mock('../limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../limits')>();
  return { ...original, MAX_TASKS: 3, MAX_DEPENDENCIES: 2, MAX_TAGS: 2 };
});

/** Opens a session on a plan already at the limits of 3 tasks and 2 links. */
function fullSession(): SharedSession {
  const opened = openSharedSession(
    createSharedDocument(
      project([workTask('a'), workTask('b'), milestone('c')], [link('a', 'b'), link('b', 'c')]),
      TEST_DOCUMENT_ID,
    ),
  );
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

describe('a session at the limits of a project', () => {
  it('refuses one more task but lets an existing task change', () => {
    const session = fullSession();
    expect(session.apply({ type: 'putTask', task: workTask('d') })).toEqual({
      ok: false,
      error: [{ path: 'tasks', code: 'TOO_MANY_ITEMS' }],
    });
    expect(session.apply({ type: 'putTask', task: workTask('a', { name: 'Renamed' }) }).ok).toBe(
      true,
    );
    expect(
      session
        .project()
        .tasks.map((task) => task.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('refuses one more link but lets an existing link change', () => {
    const session = fullSession();
    expect(session.apply({ type: 'putDependency', dependency: link('a', 'c') })).toEqual({
      ok: false,
      error: [{ path: 'dependencies', code: 'TOO_MANY_ITEMS' }],
    });
    expect(
      session.apply({ type: 'putDependency', dependency: link('a', 'b', 'startToStart', 2) }).ok,
    ).toBe(true);
    expect(session.project().dependencies).toHaveLength(2);
  });

  it.each<[string, Project, SharedOperation, SharedOperation, string[]]>([
    [
      'tasks added by two participants beyond the limit',
      project([workTask('a'), workTask('b')]),
      { type: 'putTask', task: workTask('c') },
      { type: 'putTask', task: workTask('d') },
      ['TASK_REMOVED'],
    ],
    [
      'tags added by two participants beyond the limit',
      project([workTask('a')], [], { tags: [tagOf('t1')] }),
      { type: 'putTag', tag: tagOf('t2') },
      { type: 'putTag', tag: tagOf('t3') },
      ['TAG_REMOVED'],
    ],
  ])(
    'removes %s, keeping the smallest identifiers as the full merge does',
    (_label, base, fromAlice, fromBob, expected) => {
      const origin = createSharedDocument(base, TEST_DOCUMENT_ID);
      const alice = sessionOn(origin, 1);
      const bob = sessionOn(origin, 2);
      expect(alice.apply(fromAlice).ok).toBe(true);
      const reference = sessionOn(alice.document, 3).document;
      const before = Y.encodeStateVector(bob.document);
      expect(bob.apply(fromBob).ok).toBe(true);
      const update = Y.encodeStateAsUpdate(bob.document, before);
      const merged = alice.merge(update);
      expect(merged).toEqual(mergeSharedUpdate(reference, update));
      expect(merged.ok && merged.value.map((repair) => repair.code)).toEqual(expected);
    },
  );
});

/** Builds a category tag with an identifier. */
function tagOf(id: string): Tag {
  return { id, name: id, color: '#336699', representsPersonOrTeam: false };
}

/** Opens a session on a copy of a document, failing the test when it is refused. */
function sessionOn(document: Y.Doc, clientId: number): SharedSession {
  const copy = new Y.Doc();
  copy.clientID = clientId;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}
