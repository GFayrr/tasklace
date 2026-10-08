import fc from 'fast-check';
import * as Y from 'yjs';
import type { Project } from '../model/project';
import { createSharedDocument } from '../shared/shared-document';
import { openSharedSession, type SharedSession } from '../shared/shared-session';
import { TEST_DOCUMENT_ID, workTask } from './project-builder';

const MAX_RANDOM_EDITS = 6;
const REMOVAL_EVERY = 3;
const PARTICIPANTS = 2;

export const randomEditsArbitrary: fc.Arbitrary<number[]> = fc.array(fc.nat(), {
  maxLength: MAX_RANDOM_EDITS,
});

/** Opens a session on a new document decoded from a state, failing when it is refused. */
function sessionOf(state: Uint8Array): SharedSession {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  const opened = openSharedSession(document);
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  return opened.value;
}

/** Returns the state of a document that lived: built by one participant, changed in turn by two participants whose edits remove tasks as well as add them, then merged into one. */
export function livedState(source: Project, edits: readonly number[]): Uint8Array {
  const first = sessionOf(Y.encodeStateAsUpdate(createSharedDocument(source, TEST_DOCUMENT_ID)));
  const second = sessionOf(Y.encodeStateAsUpdate(first.document));
  edits.forEach((edit, index) => {
    const task = source.tasks[edit % Math.max(source.tasks.length, 1)];
    const editor = index % PARTICIPANTS === 0 ? first : second;
    if (task !== undefined && task.kind !== 'summary' && edit % REMOVAL_EVERY === 0) {
      editor.apply({ type: 'removeTasks', ids: [task.id] });
      return;
    }
    editor.apply({ type: 'putTask', task: workTask(`added${String(index)}`) });
  });
  first.merge(Y.encodeStateAsUpdate(second.document, Y.encodeStateVector(first.document)));
  return Y.encodeStateAsUpdate(first.document);
}
