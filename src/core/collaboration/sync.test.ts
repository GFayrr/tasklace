import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { MAX_PENDING_UPDATE_BYTES } from '../limits';
import { failure, success } from '../result';
import { createSharedDocument } from '../shared/shared-document';
import type { SharedSession } from '../shared/shared-session';
import { project, TEST_DOCUMENT_ID, testId, workTask } from '../testing/project-builder';
import { sessionOn } from '../testing/session-copy';
import type { CollaborationMessage } from './messages';
import { requireParticipantId, type ParticipantId } from './participants';
import { createGuest, createHost, type Guest, type Host, type SyncEvent } from './sync';

const HOST = requireParticipantId('host');
const LEA = requireParticipantId('lea');
const NOAH = requireParticipantId('noah');

interface Network {
  readonly host: Host;
  readonly hostSession: SharedSession;
  readonly guests: Map<ParticipantId, { guest: Guest; session: SharedSession }>;
  readonly toHost: { from: ParticipantId; message: CollaborationMessage }[];
  readonly toGuests: { to: ParticipantId; message: CollaborationMessage }[];
  readonly events: { at: ParticipantId; event: SyncEvent }[];
}

/** Builds a host and two guests on copies of the same plan, with queues holding what each sends until it is delivered. */
function network(): Network {
  const origin = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);
  const hostSession = sessionOn(origin, 1);
  const toHost: Network['toHost'] = [];
  const toGuests: Network['toGuests'] = [];
  const events: Network['events'] = [];
  const host = createHost({
    session: hostSession,
    roster: null,
    tokenDigest: null,
    hostId: HOST,
    name: 'Camille',
    send: (outgoing) => toGuests.push(outgoing),
    report: (event) => events.push({ at: HOST, event }),
  });
  const guests: Network['guests'] = new Map();
  [LEA, NOAH].forEach((id, index) => {
    const session = sessionOn(origin, index + 2);
    const guest = createGuest({
      session,
      send: (message) => toHost.push({ from: id, message }),
      report: (event) => events.push({ at: id, event }),
    });
    guests.set(id, { guest, session });
  });
  return { host, hostSession, guests, toHost, toGuests, events };
}

/** Delivers every queued message, in order, until nothing is left to deliver. */
function deliverAll(net: Network): void {
  for (let rounds = 0; net.toHost.length > 0 || net.toGuests.length > 0; rounds += 1) {
    if (rounds > 1_000) {
      throw new Error('The messages never stopped.');
    }
    const toGuests = net.toGuests.splice(0);
    toGuests.forEach(({ to, message }) => net.guests.get(to)?.guest.receive(message));
    const toHost = net.toHost.splice(0);
    toHost.forEach(({ from, message }) => {
      net.host.receive(from, message);
    });
  }
}

/** Connects a guest to the host the way the transport does once it is authenticated. */
function join(net: Network, id: ParticipantId, name: string): void {
  expect(net.host.connect(id, name, null, null)).toEqual(success(null));
  net.guests.get(id)?.guest.connected();
  deliverAll(net);
}

/** Returns the session of a guest of the network. */
function sessionOf(net: Network, id: ParticipantId): SharedSession {
  const entry = net.guests.get(id);
  if (entry === undefined) {
    throw new Error(`No guest ${id}`);
  }
  return entry.session;
}

/** Renames a task of a session, failing the test when it is refused. */
function rename(session: SharedSession, id: string, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`No task ${id}`);
  }
  expect(session.apply({ type: 'putTask', task: { ...task, name } }).ok).toBe(true);
}

/** Returns the names of the tasks of a session. */
function names(session: SharedSession): string[] {
  return session.project().tasks.map((task) => task.name);
}

describe('a host and its guests', () => {
  it('gives each newcomer the plan of the host and the list of participants, newcomers in read only', () => {
    const net = network();
    rename(net.hostSession, 'a', 'Brief');
    join(net, LEA, 'Léa');
    expect(names(sessionOf(net, LEA))).toEqual(['Brief', 'b']);
    expect(
      net.host.roster().participants.map((participant) => [participant.name, participant.canEdit]),
    ).toEqual([
      ['Camille', true],
      ['Léa', false],
    ]);
    expect(
      net.events.filter(({ at, event }) => at === LEA && event.kind === 'roster'),
    ).toHaveLength(1);
  });

  it('passes the changes of the host and of every guest who may edit to everyone', () => {
    const net = network();
    join(net, LEA, 'Léa');
    join(net, NOAH, 'Noah');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    rename(sessionOf(net, LEA), 'a', 'By Léa');
    rename(net.hostSession, 'b', 'By Camille');
    deliverAll(net);
    for (const session of [net.hostSession, sessionOf(net, LEA), sessionOf(net, NOAH)]) {
      expect(names(session)).toEqual(['By Léa', 'By Camille']);
    }
  });

  it('never takes a change from a guest in read only, which keeps it and tells it could not share it', () => {
    const net = network();
    join(net, NOAH, 'Noah');
    rename(sessionOf(net, NOAH), 'a', 'Not shared');
    deliverAll(net);
    expect(names(net.hostSession)).toEqual(['a', 'b']);
    net.guests.get(NOAH)?.guest.disconnected();
    net.guests.get(NOAH)?.guest.connected();
    deliverAll(net);
    expect(net.events.filter(({ event }) => event.kind === 'unsharedChanges')).toEqual([
      { at: NOAH, event: { kind: 'unsharedChanges' } },
    ]);
  });

  it('refuses an update that reaches the host from a guest in read only, and messages from strangers or of the wrong kind', () => {
    const net = network();
    join(net, NOAH, 'Noah');
    const other = sessionOn(createSharedDocument(project([workTask('z')]), TEST_DOCUMENT_ID), 9);
    net.host.receive(NOAH, { kind: 'update', update: other.encodeState() });
    net.host.receive(requireParticipantId('stranger'), {
      kind: 'stateVector',
      vector: Y.encodeStateVector(new Y.Doc()),
    });
    net.host.receive(NOAH, { kind: 'participants', you: NOAH, participants: [] });
    net.guests.get(NOAH)?.guest.receive({ kind: 'presence', name: 'X', selectedTaskId: null });
    expect(names(net.hostSession)).toEqual(['a', 'b']);
    expect(
      net.events
        .filter(({ event }) => event.kind === 'refused')
        .map(({ at, event }) => [at, event]),
    ).toEqual([
      [HOST, { kind: 'refused', from: NOAH, reason: 'READ_ONLY' }],
      [
        HOST,
        { kind: 'refused', from: requireParticipantId('stranger'), reason: 'UNKNOWN_PARTICIPANT' },
      ],
      [HOST, { kind: 'refused', from: NOAH, reason: 'UNEXPECTED_MESSAGE' }],
      [NOAH, { kind: 'refused', from: null, reason: 'UNEXPECTED_MESSAGE' }],
    ]);
  });

  it('shares the changes a guest who may edit made while away, deletions included, when it connects again', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    net.guests.get(LEA)?.guest.disconnected();
    expect(sessionOf(net, LEA).apply({ type: 'removeTasks', ids: [testId('b')] }).ok).toBe(true);
    rename(sessionOf(net, LEA), 'a', 'Offline');
    deliverAll(net);
    expect(names(net.hostSession)).toEqual(['a', 'b']);
    net.guests.get(LEA)?.guest.connected();
    deliverAll(net);
    expect(names(net.hostSession)).toEqual(['Offline']);
  });

  it('follows the presence of each participant and drops the one who leaves from the list', () => {
    const net = network();
    join(net, LEA, 'Léa');
    net.guests.get(LEA)?.guest.setPresence('Léa B.', testId('a'));
    net.host.setPresence('Camille', testId('b'));
    deliverAll(net);
    expect(
      net.host
        .roster()
        .participants.map((participant) => [participant.name, participant.selectedTaskId]),
    ).toEqual([
      ['Camille', 'b'],
      ['Léa B.', 'a'],
    ]);
    net.host.disconnect(LEA);
    expect(net.host.roster().participants.map((participant) => participant.name)).toEqual([
      'Camille',
    ]);
  });

  it('keeps an update that depends on one not received and asks for what is missing, then merges both', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    const lea = sessionOf(net, LEA);
    const before = lea.encodeStateVector();
    rename(lea, 'a', 'First');
    const middle = lea.encodeStateVector();
    rename(lea, 'a', 'Second');
    net.toHost.splice(0);
    net.host.receive(LEA, { kind: 'update', update: lea.encodeState(middle) });
    expect(
      net.toGuests.filter(({ to, message }) => to === LEA && message.kind === 'stateVector'),
    ).toHaveLength(1);
    net.host.receive(LEA, { kind: 'update', update: lea.encodeState(before) });
    expect(names(net.hostSession)).toEqual(['Second', 'b']);
  });

  it('refuses a state vector it cannot read and malformed or oversized updates, starting afresh after them', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    net.events.splice(0);
    net.host.receive(LEA, { kind: 'stateVector', vector: Uint8Array.of(255, 255, 255) });
    net.host.receive(LEA, { kind: 'update', update: Uint8Array.of(1, 2, 3) });
    net.guests.get(LEA)?.guest.receive({ kind: 'update', update: Uint8Array.of(1, 2, 3) });
    net.guests
      .get(LEA)
      ?.guest.receive({ kind: 'stateVector', vector: Uint8Array.of(255, 255, 255) });
    expect(net.events.map(({ at, event }) => [at, event])).toEqual([
      [HOST, { kind: 'refused', from: LEA, reason: 'INVALID_STATE_VECTOR' }],
      [HOST, { kind: 'refused', from: LEA, reason: 'malformedUpdate' }],
      [LEA, { kind: 'refused', from: null, reason: 'malformedUpdate' }],
      [LEA, { kind: 'refused', from: null, reason: 'INVALID_STATE_VECTOR' }],
    ]);
    expect(MAX_PENDING_UPDATE_BYTES).toBe(2 ** 26);
  });

  it('refuses a newcomer already in the list, and a right for an unknown participant', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.connect(LEA, 'Léa again', null, null)).toEqual(failure('ALREADY_IN'));
    expect(net.host.setRight(requireParticipantId('stranger'), true)).toEqual(
      failure('UNKNOWN_PARTICIPANT'),
    );
  });

  it('tells the repairs a merge needed to the side that merged it, both copies ending the same', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    net.events.splice(0);
    const lea = sessionOf(net, LEA);
    net.guests.get(LEA)?.guest.disconnected();
    expect(
      lea.apply({
        type: 'putDependency',
        dependency: {
          id: testId('a-b'),
          predecessorId: testId('a'),
          successorId: testId('b'),
          type: 'finishToStart',
          lagHours: 0,
          predecessorBlock: null,
          successorBlock: null,
        },
      }).ok,
    ).toBe(true);
    expect(
      net.hostSession.apply({
        type: 'putDependency',
        dependency: {
          id: testId('b-a'),
          predecessorId: testId('b'),
          successorId: testId('a'),
          type: 'finishToStart',
          lagHours: 0,
          predecessorBlock: null,
          successorBlock: null,
        },
      }).ok,
    ).toBe(true);
    net.toGuests.splice(0);
    net.guests.get(LEA)?.guest.connected();
    deliverAll(net);
    expect(net.events.filter(({ event }) => event.kind === 'repairs').map(({ at }) => at)).toEqual([
      LEA,
    ]);
    expect(net.hostSession.project().dependencies.map((dependency) => dependency.id)).toEqual([
      'a-b',
    ]);
    expect(lea.project().dependencies.map((dependency) => dependency.id)).toEqual(['a-b']);
  });

  it('refuses an update it cannot join to the one kept back, and starts afresh after it', () => {
    const net = network();
    join(net, LEA, 'Léa');
    expect(net.host.setRight(LEA, true)).toEqual(success(null));
    deliverAll(net);
    const lea = sessionOf(net, LEA);
    const before = lea.encodeStateVector();
    rename(lea, 'a', 'First');
    const middle = lea.encodeStateVector();
    rename(lea, 'a', 'Second');
    net.toHost.splice(0);
    net.events.splice(0);
    net.host.receive(LEA, { kind: 'update', update: lea.encodeState(middle) });
    net.host.receive(LEA, { kind: 'update', update: Uint8Array.of(9, 9, 9) });
    net.host.receive(LEA, { kind: 'update', update: lea.encodeState(before) });
    expect(net.events.map(({ event }) => event)).toEqual([
      { kind: 'refused', from: LEA, reason: 'malformedUpdate' },
    ]);
    expect(names(net.hostSession)).toEqual(['Second', 'b']);
  });

  it('asks the host again for what is missing when an update it sends depends on one not received', () => {
    const net = network();
    join(net, LEA, 'Léa');
    const before = net.hostSession.encodeStateVector();
    rename(net.hostSession, 'a', 'First');
    const middle = net.hostSession.encodeStateVector();
    rename(net.hostSession, 'a', 'Second');
    net.toGuests.splice(0);
    net.toHost.splice(0);
    net.guests
      .get(LEA)
      ?.guest.receive({ kind: 'update', update: net.hostSession.encodeState(middle) });
    expect(net.toHost.map(({ message }) => message.kind)).toEqual(['stateVector']);
    net.guests
      .get(LEA)
      ?.guest.receive({ kind: 'update', update: net.hostSession.encodeState(before) });
    expect(names(sessionOf(net, LEA))).toEqual(['Second', 'b']);
  });

  it('sends no presence while it is not connected', () => {
    const net = network();
    net.guests.get(LEA)?.guest.setPresence('Léa', null);
    expect(net.toHost).toEqual([]);
  });
});
