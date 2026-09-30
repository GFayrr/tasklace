import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { Project } from '../model/project';
import type { DependencyType } from '../model/project';
import { link, project, summary, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { readSharedData } from './shared-document';
import { createSharedDocument } from './shared-document';
import { applyOperation, type SharedOperation } from './shared-operations';
import { readSharedProject } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const BASE: Project = project(
  [workTask('a'), workTask('b'), workTask('c')],
  [link('a', 'b'), link('b', 'c')],
);

/** Opens a session on a project. */
function openOn(base: Project): SharedSession {
  const opened = openSharedSession(createSharedDocument(base, TEST_DOCUMENT_ID));
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

/** Applies operations one after another to a whole project, the reference for grouped operations. */
function reference(base: Project, operations: readonly SharedOperation[]): Project {
  return operations.reduce(applyOperation, base);
}

/** Reads the project stored in the document of a session. */
function stored(session: SharedSession): Project | null {
  const read = readSharedProject(session.document);
  return read.ok ? read.value : null;
}

describe('grouped operations', () => {
  it('turns a task into a summary holding the next one, in a single change and a single undo step', () => {
    const session = openOn(BASE);
    const operations: SharedOperation[] = [
      { type: 'removeDependency', id: 'a-b' },
      { type: 'removeDependency', id: 'b-c' },
      { type: 'putTask', task: summary('b') },
      { type: 'putTask', task: workTask('c', { parentId: 'b' }) },
    ];
    let transactions = 0;
    session.document.on('afterTransaction', () => {
      transactions += 1;
    });
    expect(session.applyAll(operations)).toEqual({ ok: true, value: undefined });
    expect(transactions).toBe(1);
    const expected = reference(BASE, operations);
    expect(session.project()).toEqual(stored(session));
    expect(new Set(session.project().tasks)).toEqual(new Set(expected.tasks));
    expect(session.project().dependencies).toEqual([]);
    session.history.undo();
    expect(session.project()).toEqual(BASE);
  });

  it('changes nothing when one operation is refused, even after earlier ones were accepted', () => {
    const session = openOn(BASE);
    const before = Y.encodeStateAsUpdate(session.document);
    const refused = session.applyAll([
      { type: 'updateProject', fields: { name: 'Renamed' } },
      { type: 'removeDependency', id: 'a-b' },
      { type: 'putDependency', dependency: link('c', 'a') },
      { type: 'putDependency', dependency: { ...link('a', 'c'), id: 'loop' } },
    ]);
    expect(refused).toEqual({
      ok: false,
      error: [{ path: 'dependencies.loop', code: 'DEPENDENCY_CYCLE' }],
    });
    expect(Y.encodeStateAsUpdate(session.document)).toEqual(before);
    expect(session.project()).toEqual(BASE);
    expect(session.history.canUndo()).toBe(false);
    expect(session.apply({ type: 'removeDependency', id: 'a-b' }).ok).toBe(true);
    expect(session.project().dependencies).toEqual([link('b', 'c')]);
  });

  it('does nothing for an empty group', () => {
    const session = openOn(BASE);
    expect(session.applyAll([]).ok).toBe(true);
    expect(session.history.canUndo()).toBe(false);
  });
});

const TASK_IDS = ['a', 'b', 'c'];
const operationArbitrary: fc.Arbitrary<SharedOperation> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...TASK_IDS),
      fc.constantFrom(...TASK_IDS),
      fc.constantFrom<DependencyType>('finishToStart', 'startToStart', 'finishToFinish'),
      fc.integer({ min: -3, max: 3 }),
    )
    .map(([from, to, type, lag]): SharedOperation => ({
      type: 'putDependency',
      dependency: { ...link(from, to, type, lag), id: `${from}${to}` },
    })),
  fc
    .constantFrom('a-b', 'b-c', 'ab', 'bc', 'ca')
    .map((id): SharedOperation => ({ type: 'removeDependency', id })),
  fc
    .string({ maxLength: 4 })
    .map((name): SharedOperation => ({ type: 'updateProject', fields: { name } })),
  fc
    .constantFrom(...TASK_IDS)
    .map((id): SharedOperation => ({ type: 'putTask', task: workTask(id, { name: `${id}!` }) })),
);

describe('grouped operations, compared with operations one at a time', () => {
  it('give the same document when all are accepted, and leave it untouched otherwise', () => {
    fc.assert(
      fc.property(fc.array(operationArbitrary, { maxLength: 6 }), (operations) => {
        const grouped = openOn(BASE);
        const single = openOn(BASE);
        const allAccepted = operations.every((operation) => single.apply(operation).ok);
        const result = grouped.applyAll(operations);
        expect(result.ok).toBe(allAccepted);
        const expected = allAccepted ? single : openOn(BASE);
        expect(readSharedData(grouped.document)).toEqual(readSharedData(expected.document));
        expect(grouped.project()).toEqual(stored(grouped));
      }),
    );
  });
});
