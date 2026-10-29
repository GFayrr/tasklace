import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_AFTER_BYTES } from '../../limits';
import { createSharedDocument } from '../../shared/shared-document';
import type { SharedSession } from '../../shared/shared-session';
import { project, TEST_DOCUMENT_ID, testId, workTask } from '../../testing/project-builder';
import { sessionOn } from '../../testing/session-copy';
import { seededRandom } from '../../testing/test-crypto';
import { encodeMessage, readMessage } from '../messages';
import {
  createRelayMember,
  type RelayDelivery,
  type RelayMember,
  type RelayMemberEvent,
  type RelayOutgoing,
} from './relay-member';

const ORIGIN = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);

interface Harness {
  readonly session: SharedSession;
  readonly member: RelayMember;
  readonly sent: RelayOutgoing[];
  readonly events: RelayMemberEvent[];
}

/** Starts a member on its own copy of the plan, keeping what it sends and tells. */
function harness(canEdit: boolean, clientId: number, bytesSinceSnapshot = 0): Harness {
  const session = sessionOn(ORIGIN, clientId);
  const sent: RelayOutgoing[] = [];
  const events: RelayMemberEvent[] = [];
  const member = createRelayMember({
    session,
    canEdit,
    bytesSinceSnapshot,
    randomBytes: seededRandom(clientId),
    send: (outgoing) => sent.push(outgoing),
    report: (event) => events.push(event),
  });
  return { session, member, sent, events };
}

/** Renames a task of a session. */
function rename(session: SharedSession, id: string, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`No task ${id}`);
  }
  session.apply({ type: 'putTask', task: { ...task, name } });
}

/** Gives the name of a task of a session. */
function nameOf(session: SharedSession, id: string): string | undefined {
  return session.project().tasks.find((task) => task.id === id)?.name;
}

/** Turns what a member sent into what the relay passes back to everyone, at a sequence and with what is settled. */
function delivered(
  outgoing: RelayOutgoing | undefined,
  settled = 1,
  compressedBytes = 10,
): RelayDelivery {
  if (outgoing?.kind !== 'message') {
    throw new Error('A message was expected.');
  }
  return { ...outgoing.message, compressedBytes, settled };
}

/** Gives the kinds of what a member sent, with the identifiers of its messages. */
function summary(sent: readonly RelayOutgoing[]) {
  return sent.map((outgoing) =>
    outgoing.kind === 'message'
      ? `${outgoing.message.kind}:${bytesToHex(outgoing.message.messageId).slice(0, 4)}`
      : 'presence',
  );
}

describe('a member of a plan shared through a relay', () => {
  it('keeps its changes while not in, sends them once caught up, and again after coming back until the relay passes them back', () => {
    const editor = harness(true, 1);
    rename(editor.session, 'a', 'Offline');
    const keptWhileAway = editor.sent.length;
    editor.member.caughtUp();
    rename(editor.session, 'b', 'Live');
    const firstRound = summary(editor.sent);
    editor.member.disconnected();
    editor.member.caughtUp();
    const secondRound = summary(editor.sent).slice(firstRound.length);
    editor.member.receive(delivered(editor.sent[0]));
    editor.member.receive(delivered(editor.sent[1]));
    editor.member.disconnected();
    editor.member.caughtUp();
    expect([keptWhileAway, firstRound.length, secondRound, editor.sent.length]).toEqual([
      0,
      2,
      firstRound,
      4,
    ]);
  });

  it('merges the changes of the others and not its own a second time', () => {
    const editor = harness(true, 1);
    const other = harness(true, 2);
    editor.member.caughtUp();
    other.member.caughtUp();
    rename(other.session, 'a', 'From the other');
    editor.member.receive(delivered(other.sent[0]));
    rename(editor.session, 'b', 'Mine');
    editor.member.receive(delivered(editor.sent[0]));
    expect([nameOf(editor.session, 'a'), nameOf(editor.session, 'b'), editor.events]).toEqual([
      'From the other',
      'Mine',
      [],
    ]);
  });

  it('sends nothing in read only, and tells once in that its changes stay here', () => {
    const reader = harness(false, 3);
    rename(reader.session, 'a', 'Mine only');
    reader.member.caughtUp();
    rename(reader.session, 'b', 'Mine too');
    expect([reader.sent, reader.events]).toEqual([[], [{ kind: 'unsharedChanges' }]]);
  });

  it('puts the whole plan on the relay once its own change brings what changed since the last snapshot to the threshold', () => {
    const editor = harness(true, 1, SNAPSHOT_AFTER_BYTES - 10);
    const other = harness(true, 2);
    editor.member.caughtUp();
    other.member.caughtUp();
    rename(other.session, 'a', 'Theirs');
    editor.member.receive(delivered(other.sent[0], 3, 5));
    const afterTheirs = editor.sent.length;
    rename(editor.session, 'b', 'Mine');
    editor.member.receive(delivered(editor.sent[0], 4, 5));
    const snapshot = editor.sent[1];
    const read = snapshot?.kind === 'message' ? readMessage(snapshot.message.bytes) : null;
    const copy = sessionOn(ORIGIN, 9);
    if (read?.ok && read.value.kind === 'update') {
      copy.merge(read.value.update);
    }
    expect([
      afterTheirs,
      snapshot?.kind === 'message' ? [snapshot.message.kind, snapshot.message.covers] : snapshot,
      [nameOf(copy, 'a'), nameOf(copy, 'b')],
    ]).toEqual([0, ['snapshot', 4], ['Theirs', 'Mine']]);
  });

  it('counts again from a snapshot it receives, and never snapshots while a change waits for another', () => {
    const editor = harness(true, 1, SNAPSHOT_AFTER_BYTES);
    const author = harness(true, 2);
    editor.member.caughtUp();
    author.member.caughtUp();
    rename(author.session, 'a', 'One');
    rename(author.session, 'a', 'Two');
    editor.member.receive(delivered(author.sent[1]));
    rename(editor.session, 'b', 'Mine');
    editor.member.receive(delivered(editor.sent[0], 5, 1));
    const whileWaiting = editor.sent.length;
    editor.member.receive({ ...delivered(author.sent[0]), kind: 'snapshot', covers: 2 });
    rename(editor.session, 'b', 'Mine again');
    editor.member.receive(delivered(editor.sent[1], 7, 1));
    expect([whileWaiting, editor.sent.length, nameOf(editor.session, 'a')]).toEqual([1, 2, 'Two']);
  });

  it('puts the whole plan on the relay when asked once in, only for a member who may edit', () => {
    const editor = harness(true, 1);
    const reader = harness(false, 2);
    rename(editor.session, 'a', 'Shared at once');
    editor.member.caughtUp();
    reader.member.caughtUp();
    const before = editor.sent.length;
    editor.member.shareWholePlan();
    reader.member.shareWholePlan();
    const copy = sessionOn(ORIGIN, 9);
    const whole = editor.sent.at(-1);
    const read = whole?.kind === 'message' ? readMessage(whole.message.bytes) : null;
    if (read?.ok && read.value.kind === 'update') {
      copy.merge(read.value.update);
    }
    expect([editor.sent.length - before, nameOf(copy, 'a'), reader.sent]).toEqual([
      1,
      'Shared at once',
      [],
    ]);
  });

  it('adds the state the relay holds on reopening, and shares the whole plan only when this computer holds more', () => {
    const relayHolds = harness(true, 4);
    rename(relayHolds.session, 'a', 'On the relay');
    const relayState = relayHolds.session.encodeState();
    const behind = harness(true, 5);
    behind.member.catchUpWith(relayState, 0);
    behind.member.caughtUp();
    const ahead = harness(true, 6);
    rename(ahead.session, 'b', 'Only here');
    ahead.member.catchUpWith(relayState, 0);
    ahead.member.caughtUp();
    const sharedPlan = ahead.sent[0];
    const read = sharedPlan?.kind === 'message' ? readMessage(sharedPlan.message.bytes) : null;
    const copy = sessionOn(ORIGIN, 9);
    if (read?.ok && read.value.kind === 'update') {
      copy.merge(read.value.update);
    }
    expect([
      nameOf(behind.session, 'a'),
      behind.sent,
      ahead.sent.length,
      [nameOf(copy, 'a'), nameOf(copy, 'b')],
    ]).toEqual(['On the relay', [], 1, ['On the relay', 'Only here']]);
  });

  it('shares the whole plan on reopening a room nothing was put in, and keeps apart in read only what the relay lacks', () => {
    const editor = harness(true, 1);
    editor.member.catchUpWith(null, 0);
    editor.member.caughtUp();
    const reader = harness(false, 2);
    reader.member.catchUpWith(null, 0);
    reader.member.caughtUp();
    expect([editor.sent.length, reader.sent, reader.events]).toEqual([
      1,
      [],
      [{ kind: 'unsharedChanges' }],
    ]);
  });

  it('refuses a state of the relay that cannot be merged, sharing nothing for it and keeping the plan of this computer apart', () => {
    const editor = harness(true, 1);
    editor.member.catchUpWith(Uint8Array.of(1, 2, 3), 0);
    editor.member.caughtUp();
    expect([editor.events, editor.sent]).toEqual([
      [{ kind: 'refused', reason: 'malformedUpdate' }, { kind: 'unsharedChanges' }],
      [],
    ]);
  });

  it('counts from the bytes it is given on reopening toward the next snapshot', () => {
    const editor = harness(true, 1);
    editor.member.catchUpWith(editor.session.encodeState(), SNAPSHOT_AFTER_BYTES - 1);
    editor.member.caughtUp();
    rename(editor.session, 'b', 'Mine');
    editor.member.receive(delivered(editor.sent[0], 2, 1));
    const last = editor.sent.at(-1);
    expect([editor.sent.length, last?.kind === 'message' ? last.message.kind : null]).toEqual([
      2,
      'snapshot',
    ]);
  });

  it('sends no other snapshot while its own is on its way, and may again once it came back or the connection was lost', () => {
    const editor = harness(true, 1);
    editor.member.catchUpWith(editor.session.encodeState(), SNAPSHOT_AFTER_BYTES - 1);
    editor.member.caughtUp();
    rename(editor.session, 'b', 'Mine');
    editor.member.receive(delivered(editor.sent[0], 2, SNAPSHOT_AFTER_BYTES));
    rename(editor.session, 'b', 'Again');
    editor.member.receive(delivered(editor.sent[2], 3, SNAPSHOT_AFTER_BYTES));
    const whileOnItsWay = editor.sent.length;
    editor.member.disconnected();
    editor.member.caughtUp();
    rename(editor.session, 'b', 'Once more');
    editor.member.receive(delivered(editor.sent.at(-1), 4, SNAPSHOT_AFTER_BYTES));
    expect([whileOnItsWay, summary(editor.sent).map((entry) => entry.split(':')[0])]).toEqual([
      3,
      ['update', 'snapshot', 'update', 'update', 'snapshot'],
    ]);
  });

  it('refuses a message that is not one, one of another kind, and a change that cannot be merged', () => {
    const editor = harness(true, 1);
    const base = {
      kind: 'update' as const,
      messageId: new Uint8Array(16),
      covers: 0,
      compressedBytes: 1,
      settled: 1,
    };
    editor.member.receive({ ...base, bytes: Uint8Array.of(9, 9) });
    editor.member.receive({ ...base, bytes: encodeMessage({ kind: 'refused' }) });
    editor.member.receive({
      ...base,
      bytes: encodeMessage({ kind: 'update', update: Uint8Array.of(1, 2, 3) }),
    });
    expect(editor.events).toEqual([
      { kind: 'refused', reason: 'UNSUPPORTED_VERSION' },
      { kind: 'refused', reason: 'UNEXPECTED_MESSAGE' },
      { kind: 'refused', reason: 'malformedUpdate' },
    ]);
  });

  it('follows who is in from their presence, telling who may edit, and forgets everyone once out', () => {
    const editor = harness(true, 1);
    const presence = encodeMessage({ kind: 'presence', name: 'Léa', selectedTaskId: testId('a') });
    editor.member.presence(4, { bytes: presence, canEdit: true });
    editor.member.presence(5, {
      bytes: encodeMessage({ kind: 'presence', name: 'Noah', selectedTaskId: null }),
      canEdit: false,
    });
    editor.member.left(4);
    editor.member.left(9);
    editor.member.presence(6, { bytes: Uint8Array.of(1), canEdit: false });
    editor.member.presence(6, { bytes: encodeMessage({ kind: 'refused' }), canEdit: false });
    editor.member.disconnected();
    expect(editor.events).toEqual([
      {
        kind: 'people',
        people: new Map([[4, { name: 'Léa', selectedTaskId: 'a', canEdit: true }]]),
      },
      {
        kind: 'people',
        people: new Map([
          [4, { name: 'Léa', selectedTaskId: 'a', canEdit: true }],
          [5, { name: 'Noah', selectedTaskId: null, canEdit: false }],
        ]),
      },
      {
        kind: 'people',
        people: new Map([[5, { name: 'Noah', selectedTaskId: null, canEdit: false }]]),
      },
      { kind: 'refused', reason: 'UNSUPPORTED_VERSION' },
      { kind: 'refused', reason: 'UNEXPECTED_MESSAGE' },
      { kind: 'people', people: new Map() },
    ]);
  });

  it('sends its presence only while in, and nothing once stopped', () => {
    const editor = harness(true, 1);
    editor.member.setPresence('Camille', null);
    editor.member.caughtUp();
    editor.member.setPresence('Camille', testId('b'));
    editor.member.stop();
    rename(editor.session, 'a', 'After stop');
    expect(editor.sent).toEqual([
      {
        kind: 'presence',
        bytes: encodeMessage({ kind: 'presence', name: 'Camille', selectedTaskId: testId('b') }),
      },
    ]);
  });
});
