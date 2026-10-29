import { describe, expect, it, vi } from 'vitest';
import { createSharedDocument } from '../../shared/shared-document';
import type { SharedSession } from '../../shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../testing/project-builder';
import { sessionOn } from '../../testing/session-copy';
import { seededRandom } from '../../testing/test-crypto';
import { readMessage } from '../messages';
import { createRelayMember, type RelayOutgoing } from './relay-member';

const limits = vi.hoisted(() => ({ pending: 0 }));

vi.mock('../../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits')>()),
  get MAX_PENDING_UPDATE_BYTES() {
    return limits.pending;
  },
}));

const ORIGIN = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);

/** Renames the only task of a session. */
function rename(session: SharedSession, name: string): void {
  const [task] = session.project().tasks;
  if (task !== undefined) {
    session.apply({ type: 'putTask', task: { ...task, name } });
  }
}

/** Gives the name of the only task of the plan a sent change holds, merged into a fresh copy. */
function nameIn(outgoing: RelayOutgoing | undefined): string | undefined {
  const read = outgoing?.kind === 'message' ? readMessage(outgoing.message.bytes) : null;
  const copy = sessionOn(ORIGIN, 9);
  if (read?.ok && read.value.kind === 'update') {
    copy.merge(read.value.update);
  }
  return copy.project().tasks[0]?.name;
}

describe('the changes a member keeps until the relay passes them back', () => {
  it('replaces them by the whole plan once they grow beyond the limit, sending only that once back in', () => {
    const session = sessionOn(ORIGIN, 1);
    const sent: RelayOutgoing[] = [];
    const member = createRelayMember({
      session,
      canEdit: true,
      bytesSinceSnapshot: 0,
      randomBytes: seededRandom(1),
      send: (outgoing) => sent.push(outgoing),
      report: () => undefined,
    });
    limits.pending = 1;
    rename(session, 'First');
    rename(session, 'Second');
    member.caughtUp();
    const whileAway = [sent.length, nameIn(sent[0])];
    rename(session, 'Third');
    expect([...whileAway, sent.length, nameIn(sent[1])]).toEqual([1, 'Second', 2, 'Third']);
  });
});
