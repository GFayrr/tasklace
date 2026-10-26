import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { holdsChangesMissingFrom } from '../../file/tasklace-file';
import { createSharedDocument } from '../../shared/shared-document';
import type { SharedSession } from '../../shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../testing/project-builder';
import { sessionOn } from '../../testing/session-copy';
import { encodeMessage } from '../messages';
import { readRelayLog } from './relay-log';

const ORIGIN = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);

/** Encodes a change of the plan as the message a member puts on the relay. */
function updateMessage(update: Uint8Array): Uint8Array {
  return encodeMessage({ kind: 'update', update });
}

/** Renames a task of a session, giving the change it made. */
function renamed(session: SharedSession, id: string, name: string): Uint8Array {
  const changes: Uint8Array[] = [];
  const stop = session.onUpdate((update) => changes.push(update));
  const task = session.project().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`No task ${id}.`);
  }
  session.apply({ type: 'putTask', task: { ...task, name } });
  stop();
  return Y.mergeUpdates(changes);
}

describe('reading the log a relay passed on', () => {
  it('merges a snapshot and the changes after it into the state of the plan', () => {
    const session = sessionOn(ORIGIN, 1);
    const snapshot = updateMessage(session.encodeState());
    const first = updateMessage(renamed(session, 'a', 'Survey'));
    const second = updateMessage(renamed(session, 'b', 'Build'));
    const read = readRelayLog([snapshot, first, second]);
    expect(
      read.ok && [
        read.value.documentId,
        holdsChangesMissingFrom(read.value.state, session.encodeState()),
        holdsChangesMissingFrom(session.encodeState(), read.value.state),
      ],
    ).toEqual([TEST_DOCUMENT_ID, false, false]);
  });

  it.each([
    [
      'a message that is not a change of the plan',
      [encodeMessage({ kind: 'stateVector', vector: new Uint8Array(1) })],
      'INVALID_CONTENT',
    ],
    ['bytes that are not a message', [Uint8Array.of(9, 9, 9)], 'INVALID_CONTENT'],
    ['one change Yjs cannot read', [updateMessage(Uint8Array.of(200, 1, 2, 3))], 'INVALID_CONTENT'],
    [
      'changes Yjs cannot merge',
      [updateMessage(Uint8Array.of(1)), updateMessage(Uint8Array.of(1))],
      'INVALID_CONTENT',
    ],
    [
      'changes waiting for others never received',
      [updateMessage(renamed(sessionOn(ORIGIN, 2), 'a', 'Alone'))],
      'INVALID_CONTENT',
    ],
    ['no message at all, which holds no plan', [], 'INVALID_PROJECT'],
  ])('refuses %s', (_name, messages, code) => {
    const read = readRelayLog(messages);
    expect(read.ok ? null : read.error.code).toBe(code);
  });
});
