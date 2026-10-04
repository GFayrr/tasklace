import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { projectArbitrary, richProjectArbitrary } from '../testing/project-arbitrary';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import type { Project } from '../model/project';
import { createSharedDocument, readSharedData } from './shared-document';
import type { SharedOperation } from './shared-operations';
import { openSharedSession, type SharedSession } from './shared-session';

/** Decodes a Yjs state into a new document. */
function documentOf(state: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  return document;
}

/** Opens a session on a new document decoded from a state, telling it that state or not, failing the test when it is refused. */
function sessionFrom(state: Uint8Array, toldState: boolean): SharedSession {
  const document = documentOf(state);
  const opened = openSharedSession(document, toldState ? state : null);
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

/** Returns the update a peer sends after an operation, the peer holding everything a session's document holds, its opening repairs included. */
function peerUpdate(session: SharedSession, operation: SharedOperation): Uint8Array {
  const peer = sessionFrom(Y.encodeStateAsUpdate(session.document), false);
  const before = Y.encodeStateVector(peer.document);
  peer.apply(operation);
  return Y.encodeStateAsUpdate(peer.document, before);
}

/** Compares a session opened from the state it was decoded from with one opened as before, through an update from a peer that saw all of its document, a local change and an undo. */
function expectSameDecisions(source: Project, operation: SharedOperation): void {
  const state = Y.encodeStateAsUpdate(createSharedDocument(source, TEST_DOCUMENT_ID));
  const told = sessionFrom(state, true);
  const untold = sessionFrom(state, false);
  expect(told.openingRepairs).toEqual(untold.openingRepairs);
  expect(told.merge(peerUpdate(told, operation))).toEqual(
    untold.merge(peerUpdate(untold, operation)),
  );
  expect(readSharedData(told.document)).toEqual(readSharedData(untold.document));
  const local = { type: 'putTask', task: workTask('local', { name: 'Local' }) } as const;
  expect(told.apply(local)).toEqual(untold.apply(local));
  expect(told.history.undo()).toEqual(untold.history.undo());
  expect(told.project()).toEqual(untold.project());
}

describe('opening a session from the state its document was decoded from', () => {
  it(
    'takes the same decisions as a session that encodes its document again',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(fc.oneof(projectArbitrary, richProjectArbitrary), ({ project: generated }) => {
          const [first] = generated.tasks;
          const renamed: SharedOperation =
            first === undefined || first.kind === 'summary'
              ? { type: 'updateProject', fields: { name: 'Renamed' } }
              : { type: 'putTask', task: { ...first, name: 'Renamed by a peer' } };
          expectSameDecisions(generated, renamed);
        }),
      );
    },
  );

  it('takes the same decisions after the opening cleared a missing tag, the copy then encoding the cleared document', () => {
    const withMissingTag = project([workTask('a'), workTask('lost', { tagId: 'deleted' })]);
    expectSameDecisions(withMissingTag, { type: 'putDependency', dependency: link('a', 'lost') });
    const state = Y.encodeStateAsUpdate(createSharedDocument(withMissingTag, TEST_DOCUMENT_ID));
    expect(sessionFrom(state, true).openingRepairs).toEqual([{ code: 'TAG_CLEARED', id: 'lost' }]);
  });
});
