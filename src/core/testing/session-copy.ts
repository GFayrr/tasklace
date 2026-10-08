import * as Y from 'yjs';
import { openSharedSession, type SharedSession } from '../shared/shared-session';

/** Opens a session on a copy of a document, under a given client identifier when one is given, failing the test when it is refused. */
export function sessionOn(document: Y.Doc, clientId?: number): SharedSession {
  const copy = new Y.Doc();
  if (clientId !== undefined) {
    copy.clientID = clientId;
  }
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}
