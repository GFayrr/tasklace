import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Project } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { livedState, randomEditsArbitrary } from '../testing/lived-document';
import { projectArbitrary, richProjectArbitrary } from '../testing/project-arbitrary';
import { link, project, TEST_DOCUMENT_ID, workTask, testId } from '../testing/project-builder';
import { createSharedDocument, readSharedData, TASKS_ROOT } from './shared-document';
import type { SharedOperation } from './shared-operations';
import {
  openSharedSession,
  openSharedSessionFromState,
  type SharedSession,
  sessionDocument,
} from './shared-session';

/** Decodes a Yjs state into a new document. */
function documentOf(state: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  return document;
}

/** Opens a session from a state, or on the document the state gives as before, failing the test when it is refused. */
function sessionFrom(state: Uint8Array, fromState: boolean): SharedSession {
  const opened = fromState
    ? openSharedSessionFromState(state)
    : openSharedSession(documentOf(state));
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

/** Returns the update a peer sends after operations, the peer holding everything a session's document holds, its opening repairs included. */
function peerUpdate(session: SharedSession, operations: readonly SharedOperation[]): Uint8Array {
  const peer = sessionFrom(Y.encodeStateAsUpdate(sessionDocument(session)), false);
  const before = Y.encodeStateVector(sessionDocument(peer));
  operations.forEach((operation) => {
    peer.apply(operation);
  });
  return Y.encodeStateAsUpdate(sessionDocument(peer), before);
}

/** Checks that a session opened from a state takes the same decisions as one opened on the document that state gives, on updates from peers, a local change and an undo. */
function expectSameDecisions(
  state: Uint8Array,
  peers: readonly (readonly SharedOperation[])[],
): void {
  const fromState = sessionFrom(state, true);
  const asBefore = sessionFrom(state, false);
  expect(fromState.openingRepairs).toEqual(asBefore.openingRepairs);
  const updates = peers.map((operations) => [
    peerUpdate(fromState, operations),
    peerUpdate(asBefore, operations),
  ]);
  updates.forEach(([forState, forBefore]) => {
    expect(forState && fromState.merge(forState)).toEqual(forBefore && asBefore.merge(forBefore));
  });
  expect(readSharedData(sessionDocument(fromState))).toEqual(
    readSharedData(sessionDocument(asBefore)),
  );
  const local = { type: 'putTask', task: workTask('local', { name: 'Local' }) } as const;
  expect(fromState.apply(local)).toEqual(asBefore.apply(local));
  expect(fromState.history.undo()).toEqual(asBefore.history.undo());
  expect(fromState.project()).toEqual(asBefore.project());
}

/** Returns the operation a peer makes on the first task of a project, or on the project when it has none. */
function peerChange(source: Project): SharedOperation {
  const [first] = source.tasks;
  return first === undefined || first.kind === 'summary'
    ? { type: 'updateProject', fields: { name: 'Renamed' } }
    : { type: 'putTask', task: { ...first, name: 'Renamed by a peer' } };
}

type TrialStep =
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'peer'; readonly name: string }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };

const trialStepArbitrary: fc.Arbitrary<TrialStep> = fc.oneof(
  fc.record({
    kind: fc.constant('local' as const),
    name: fc.string({ minLength: 1, maxLength: 8 }),
  }),
  fc.record({
    kind: fc.constant('peer' as const),
    name: fc.string({ minLength: 1, maxLength: 8 }),
  }),
  fc.constant({ kind: 'undo' as const }),
  fc.constant({ kind: 'redo' as const }),
);

/** Plays a step on a session, a local step adding a task and renaming the project, a peer step adding a task that waits for the last task, and returns what the session answered. */
function playTrialStep(session: SharedSession, step: TrialStep, index: number): unknown {
  switch (step.kind) {
    case 'local':
      return session.applyAll([
        { type: 'putTask', task: workTask(`local${String(index)}`) },
        { type: 'updateProject', fields: { name: step.name } },
      ]);
    case 'peer':
      return session.merge(
        peerUpdate(session, peerTrialChange(session.project(), step.name, index)),
      );
    case 'undo':
      return session.history.undo();
    case 'redo':
      return session.history.redo();
  }
}

/** Returns the changes of a peer: a new task named as given, waiting for the last task of the project unless it is a summary. */
function peerTrialChange(source: Project, name: string, index: number): SharedOperation[] {
  const id = `peer${String(index)}`;
  const last = source.tasks.at(-1);
  const put: SharedOperation = { type: 'putTask', task: workTask(id, { name }) };
  return last === undefined || last.kind === 'summary'
    ? [put]
    : [put, { type: 'putDependency', dependency: { ...link(last.id, id), id: testId(`l${id}`) } }];
}

describe('opening a session from a state', () => {
  it(
    'takes the same decisions as a session opened on the document that state gives, for new and lived documents',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.oneof(projectArbitrary, richProjectArbitrary),
          randomEditsArbitrary,
          ({ project: generated }, edits) => {
            expectSameDecisions(livedState(generated, edits), [[peerChange(generated)]]);
          },
        ),
      );
    },
  );

  it('takes the same decisions on concurrent links that the merge must repair as a loop', () => {
    const state = Y.encodeStateAsUpdate(
      createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID),
    );
    expectSameDecisions(state, [
      [{ type: 'putDependency', dependency: link('a', 'b') }],
      [{ type: 'putDependency', dependency: { ...link('b', 'a'), id: testId('zz') } }],
    ]);
  });

  it('takes the same decisions after the opening cleared a missing tag, the copy then encoding the cleared document', () => {
    const withMissingTag = project([workTask('a'), workTask('lost', { tagId: 'deleted' })]);
    const state = Y.encodeStateAsUpdate(createSharedDocument(withMissingTag, TEST_DOCUMENT_ID));
    expectSameDecisions(state, [[{ type: 'putDependency', dependency: link('a', 'lost') }]]);
    expect(sessionFrom(state, true).openingRepairs).toEqual([{ code: 'TAG_CLEARED', id: 'lost' }]);
  });

  it('writes its repairs under an identity other than that of its document', () => {
    const state = Y.encodeStateAsUpdate(
      createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID),
    );
    const session = sessionFrom(state, true);
    const peer = documentOf(Y.encodeStateAsUpdate(sessionDocument(session)));
    const before = Y.encodeStateVector(peer);
    const task: unknown = peer.getMap(TASKS_ROOT).get('a');
    if (!(task instanceof Y.Map)) {
      throw new Error('The task is missing.');
    }
    task.set('tagId', 'missing');
    const documentClient = sessionDocument(session).clientID;
    const clients = new Set<number>();
    sessionDocument(session).on('update', (update: Uint8Array) => {
      Y.decodeUpdate(update).structs.forEach((struct) => clients.add(struct.id.client));
    });
    const merged = session.merge(Y.encodeStateAsUpdate(peer, before));
    expect(merged).toEqual({ ok: true, value: [{ code: 'TAG_CLEARED', id: 'a' }] });
    clients.delete(peer.clientID);
    const [repairer, ...others] = clients;
    expect(others).toEqual([]);
    expect(repairer).not.toBeUndefined();
    expect(repairer).not.toBe(documentClient);
    expect(sessionDocument(session).clientID).toBe(documentClient);
  });

  it(
    'answers the same whenever its trial copy is made: at opening, ahead at any moment, or at its first need',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.oneof(projectArbitrary, richProjectArbitrary),
          randomEditsArbitrary,
          fc.array(trialStepArbitrary, { maxLength: 12 }),
          fc.nat({ max: 12 }),
          ({ project: generated }, edits, steps, preparedAt) => {
            const state = livedState(generated, edits);
            const early = sessionFrom(state, true);
            early.prepareTrialCopy();
            const ahead = sessionFrom(state, true);
            const late = sessionFrom(state, true);
            steps.forEach((step, index) => {
              if (index === preparedAt) {
                ahead.prepareTrialCopy();
              }
              const answer = playTrialStep(early, step, index);
              expect(playTrialStep(ahead, step, index)).toEqual(answer);
              expect(playTrialStep(late, step, index)).toEqual(answer);
            });
            [ahead, late].forEach((session) => {
              expect(session.project()).toEqual(early.project());
              expect(readSharedData(sessionDocument(session))).toEqual(
                readSharedData(sessionDocument(early)),
              );
            });
          },
        ),
      );
    },
  );

  it('gives a trial copy made after local changes everything the document gained, so that a peer may build on them', () => {
    const state = Y.encodeStateAsUpdate(
      createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID),
    );
    const session = sessionFrom(state, true);
    expect(session.apply({ type: 'putTask', task: workTask('local') })).toEqual({
      ok: true,
      value: undefined,
    });
    const update = peerUpdate(session, [{ type: 'putDependency', dependency: link('local', 'a') }]);
    expect(session.merge(update)).toEqual({ ok: true, value: [] });
    expect(session.project().dependencies).toEqual([link('local', 'a')]);
  });

  it('keeps its trial copy in step with local changes when the page asks for it again', () => {
    const state = Y.encodeStateAsUpdate(
      createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID),
    );
    const session = sessionFrom(state, true);
    session.prepareTrialCopy();
    expect(session.apply({ type: 'putTask', task: workTask('b') })).toEqual({
      ok: true,
      value: undefined,
    });
    session.prepareTrialCopy();
    const update = peerUpdate(session, [{ type: 'putDependency', dependency: link('b', 'a') }]);
    expect(session.merge(update)).toEqual({ ok: true, value: [] });
    expect(session.history.undo()).toEqual({
      ok: true,
      value: [{ code: 'DEPENDENCY_REMOVED', id: 'b-a' }],
    });
    expect(session.project().tasks.map((task) => task.id)).toEqual([testId('a')]);
    expect(session.project().dependencies).toEqual([]);
  });

  it('refuses a state that cannot be read, that depends on updates it lacks, or whose project is not valid', () => {
    const unreadable = openSharedSessionFromState(Uint8Array.of(255, 255, 255));
    expect(unreadable.ok || unreadable.error.kind).toBe('unreadableState');
    const source = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
    const before = Y.encodeStateVector(source);
    source.getMap('project').set('name', 'Later');
    const later = Y.encodeStateAsUpdate(source, before);
    expect(openSharedSessionFromState(later)).toEqual({
      ok: false,
      error: {
        kind: 'unreadableState',
        error: new Error('The state depends on updates it does not hold.'),
      },
    });
    source.getMap('project').delete('documentId');
    expect(openSharedSessionFromState(Y.encodeStateAsUpdate(source))).toEqual({
      ok: false,
      error: { kind: 'invalidProject', issues: [{ path: 'documentId', code: 'MISSING_FIELD' }] },
    });
  });
});
