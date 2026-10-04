import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { createSharedDocument } from './shared-document';
import type { SharedOperation } from './shared-operations';
import { readSharedProject } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const failing = vi.hoisted(() => ({ name: null as string | null }));

vi.mock('./shared-operations', async (importOriginal) => {
  const original = await importOriginal<typeof import('./shared-operations')>();
  return {
    ...original,
    applyToState: (...values: Parameters<typeof original.applyToState>) => {
      const checked = original.applyToState(...values);
      const [, operation] = values;
      if (operation.type === 'putTask' && operation.task.name === failing.name) {
        throw new Error('operation broken');
      }
      return checked;
    },
  };
});

const EXPLODING = 'Exploding';

afterEach(() => {
  failing.name = null;
});

/** Opens a session on a small plan, failing the test when it is refused. */
function openSession(): SharedSession {
  const opened = openSharedSession(
    createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID),
  );
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

/** Returns an operation adding a task with a name. */
function adding(id: string, name: string): SharedOperation {
  return { type: 'putTask', task: workTask(id, { name }) };
}

/** Checks that the project of a session is the one its document holds and the one it had before, its state refusing a link to the task that was never written. */
function expectUnchanged(
  session: SharedSession,
  before: ReturnType<SharedSession['project']>,
): void {
  expect(session.project()).toEqual(before);
  const read = readSharedProject(session.document);
  expect(read.ok && read.value.tasks.map((task) => task.id).sort()).toEqual(['a', 'b']);
  const linked = session.apply({ type: 'putDependency', dependency: link('a', 'c') });
  expect(linked.ok).toBe(false);
}

describe('a session whose change fails partway', () => {
  it('puts its state back as the document holds it when an operation raises in a group, then changes again', () => {
    const session = openSession();
    const before = session.project();
    failing.name = EXPLODING;
    expect(() => session.applyAll([adding('c', 'Kept out'), adding('d', EXPLODING)])).toThrow(
      'operation broken',
    );
    expectUnchanged(session, before);
    failing.name = null;
    expect(session.applyAll([adding('c', 'Added')]).ok).toBe(true);
    expect(
      session
        .project()
        .tasks.map((task) => task.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('puts its state back when a single operation raises', () => {
    const session = openSession();
    const before = session.project();
    failing.name = EXPLODING;
    expect(() => session.apply(adding('c', EXPLODING))).toThrow('operation broken');
    expectUnchanged(session, before);
  });

  it('puts its state back when writing to the document raises, for one operation or a group', () => {
    const session = openSession();
    const before = session.project();
    const transact = vi.spyOn(session.document, 'transact');
    transact.mockImplementationOnce(() => {
      throw new Error('write broken');
    });
    expect(() => session.apply(adding('c', 'Not written'))).toThrow('write broken');
    expectUnchanged(session, before);
    transact.mockImplementationOnce(() => {
      throw new Error('write broken');
    });
    expect(() => session.applyAll([adding('c', 'Not written')])).toThrow('write broken');
    expectUnchanged(session, before);
    transact.mockRestore();
    expect(session.apply(adding('c', 'Written')).ok).toBe(true);
  });

  it('refuses to keep a wrong state when its document no longer holds a valid project', () => {
    const session = openSession();
    Y.transact(session.document, () => {
      session.document.getMap('project').set('name', 42);
    });
    expect(() =>
      session.applyAll([adding('c', 'Valid'), { type: 'updateProject', fields: { name: '' } }]),
    ).toThrow('The shared document of the session no longer holds a valid project.');
  });
});
