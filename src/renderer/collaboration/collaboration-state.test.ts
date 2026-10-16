import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage, readMessage } from '../../core/collaboration/messages';
import { requireParticipantId } from '../../core/collaboration/participants';
import { MAX_PARTICIPANTS } from '../../core/limits';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSessionFromState, type SharedSession } from '../../core/shared/shared-session';
import {
  link,
  project,
  TEST_DOCUMENT_ID,
  testId,
  workTask,
} from '../../core/testing/project-builder';
import { sessionOn } from '../../core/testing/session-copy';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import { fakeBridge, type FakeCollaboration } from '../app/testing/fake-app-context';
import { CollaborationState, EMPTY_STATE_VECTOR } from './collaboration-state.svelte';

const LEA = requireParticipantId('lea');
const HOST_ID = requireParticipantId('camille');
const ENDPOINT = { addresses: [], port: 47_313 };
const PLAN_NAME = project([]).name;
const JOINED_AT = new Date('2026-10-16T10:42:00');

/** Waits for the microtasks and promises queued so far. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Builds one side of a shared plan around a fake bridge, with its session and identifiers. */
function side(session: SharedSession | null, ids: readonly string[]) {
  const { bridge, control } = fakeBridge();
  let current = session;
  let selected: string | null = null;
  const remaining = [...ids];
  const opened: Uint8Array[] = [];
  const repairs: unknown[] = [];
  const hostChanges: [string | null, string | null][] = [];
  let openSucceeds = true;
  const state: CollaborationState = new CollaborationState({
    bridge: bridge,
    createId: () => {
      const next = remaining.shift();
      if (next === undefined) {
        throw new Error('No identifier left');
      }
      return testId(next);
    },
    now: () => JOINED_AT,
    session: () => current,
    openShared: (bytes) => {
      opened.push(bytes);
      const read = openSharedSessionFromState(bytes);
      if (!openSucceeds || !read.ok) {
        return Promise.resolve(false);
      }
      current = read.value;
      state.attached(read.value);
      return Promise.resolve(true);
    },
    repaired: (found) => repairs.push(...found),
    hostChanged: (left, next) => hostChanges.push([left, next]),
    selectedTaskId: () => (selected === null ? null : testId(selected)),
  });
  return {
    state,
    collaboration: control.collaboration,
    opened,
    repairs,
    hostChanges,
    session: () => current,
    select: (id: string | null) => {
      selected = id;
      state.selectionChanged();
    },
    failOpening: () => {
      openSucceeds = false;
    },
  };
}

/** Gives an event to a side as its main process would. */
function emit(collaboration: FakeCollaboration, event: CollaborationEvent): void {
  collaboration.listener?.(event);
}

/** Sets the name of a side, as the person types it once. */
async function named(state: CollaborationState, name: string): Promise<void> {
  expect(await state.saveSettings({ name })).toEqual({ ok: true, value: null });
}

/** Builds a host sharing a plan of two tasks and a guest that joined it, passing their messages until both are quiet. */
async function sharedPair() {
  const origin = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);
  const host = side(sessionOn(origin, 1), ['camille']);
  const guest = side(null, ['lea']);
  await named(host.state, 'Camille');
  await named(guest.state, 'Léa');
  expect((await host.state.share()).ok).toBe(true);
  expect(await guest.state.join({ address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ' })).toEqual(
    {
      ok: true,
      value: null,
    },
  );
  emit(host.collaboration, {
    kind: 'peerJoined',
    peer: 1,
    participantId: 'lea',
    name: 'Léa',
    endpoint: ENDPOINT,
    tokenDigest: 'd'.repeat(64),
  });
  emit(guest.collaboration, { kind: 'connected' });
  /** Carries the messages each side sent to the other, until nothing is left. */
  const relay = async (): Promise<void> => {
    await settle();
    while (host.collaboration.sent.length > 0 || guest.collaboration.sent.length > 0) {
      for (const [, message] of host.collaboration.sent.splice(0)) {
        emit(guest.collaboration, { kind: 'hostMessage', message });
      }
      for (const [, message] of guest.collaboration.sent.splice(0)) {
        emit(host.collaboration, { kind: 'peerMessage', peer: 1, message });
      }
      await settle();
    }
  };
  await relay();
  return { host, guest, relay };
}

/** Renames a task in a session. */
function rename(session: SharedSession | null, id: string, name: string): void {
  const task = session?.project().tasks.find((candidate) => candidate.id === id);
  if (session === null || task === undefined) {
    throw new Error('No such task');
  }
  expect(session.apply({ type: 'putTask', task: { ...task, name } }).ok).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sharing a plan from the page', () => {
  it('needs an open plan and a name before sharing', async () => {
    const empty = side(null, []);
    expect(await empty.state.share()).toEqual({ ok: false, error: { code: 'NO_PROJECT' } });
    const nameless = side(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)), []);
    await nameless.state.loadSettings();
    expect(await nameless.state.share()).toEqual({ ok: false, error: { code: 'NO_NAME' } });
    expect(await nameless.state.join({ address: 'a', port: 1, code: 'K7Q4MZ' })).toEqual({
      ok: false,
      error: { code: 'NO_NAME' },
    });
  });

  it('gives back why the main process could not share, staying idle', async () => {
    const page = side(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)), ['camille']);
    await named(page.state, 'Camille');
    page.collaboration.shareResult = { ok: false, error: { code: 'NO_FREE_PORT' } };
    expect(await page.state.share()).toEqual({ ok: false, error: { code: 'NO_FREE_PORT' } });
    expect(page.state.mode).toEqual({ kind: 'idle' });
  });

  it('opens the plan the host sent to a guest, in read only, with the people in it', async () => {
    const { host, guest } = await sharedPair();
    expect(host.state.mode).toEqual({
      kind: 'hosting',
      sharing: {
        code: 'K7Q4MZ',
        port: 47_313,
        addresses: ['192.168.1.24'],
        tokenDigest: 'd'.repeat(64),
      },
    });
    expect(guest.collaboration.requests.find(([name]) => name === 'join')).toEqual([
      'join',
      { address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ', participantId: 'lea', name: 'Léa' },
    ]);
    expect(guest.opened).toHaveLength(1);
    expect(guest.session()?.project()).toEqual(host.session()?.project());
    expect([
      guest.state.mode,
      guest.state.me,
      guest.state.isReadOnly,
      guest.state.hostName,
    ]).toEqual([{ kind: 'guest', connection: 'connected' }, LEA, true, 'Camille']);
    expect(
      host.state.participants.map((participant) => [participant.name, participant.canEdit]),
    ).toEqual([
      ['Camille', true],
      ['Léa', false],
    ]);
    expect([host.state.isReadOnly, host.state.me]).toEqual([false, HOST_ID]);
  });

  it('sends a guest who joins the people in the plan at once', async () => {
    const host = side(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)), ['camille']);
    await named(host.state, 'Camille');
    await host.state.share();
    await settle();
    host.collaboration.sent.splice(0);
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 1,
      participantId: 'lea',
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    const sent = host.collaboration.sent.map(([to, message]) => {
      const read = readMessage(message);
      return [to, read.ok ? read.value.kind : read.error];
    });
    expect(sent).toEqual([[1, 'participants']]);
  });

  it('first asks the host for the whole plan with an empty state vector', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: 'K7Q4MZ' });
    emit(guest.collaboration, { kind: 'connected' });
    expect(guest.collaboration.sent).toEqual([
      ['host', encodeMessage({ kind: 'stateVector', vector: EMPTY_STATE_VECTOR })],
    ]);
  });

  it('shares the changes of a guest once the host lets it edit, and the changes of the host', async () => {
    const { host, guest, relay } = await sharedPair();
    expect(host.state.setRight(LEA, true)).toBe(true);
    await relay();
    expect(guest.state.isReadOnly).toBe(false);
    rename(guest.session(), 'a', 'From Léa');
    rename(host.session(), 'b', 'From Camille');
    await relay();
    expect(
      host
        .session()
        ?.project()
        .tasks.map((task) => task.name),
    ).toEqual(['From Léa', 'From Camille']);
    expect(guest.session()?.project()).toEqual(host.session()?.project());
    expect(host.state.setRight(requireParticipantId('nobody'), true)).toBe(false);
    expect(guest.state.setRight(HOST_ID, false)).toBe(false);
  });

  it('shows the task each person selected', async () => {
    const { host, guest, relay } = await sharedPair();
    guest.select('b');
    host.select('a');
    await relay();
    expect(host.state.participants.map((participant) => participant.selectedTaskId)).toEqual([
      'a',
      'b',
    ]);
    expect(guest.state.participants.map((participant) => participant.selectedTaskId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('replaces the old connection of a person who comes back on a new one, keeping the right, and turns away an invalid identifier', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = await sharedPair();
    expect(host.state.setRight(LEA, true)).toBe(true);
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 2,
      participantId: 'lea',
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 3,
      participantId: 'a b',
      name: 'Fake',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    expect(host.collaboration.requests.filter(([name]) => name === 'dropPeer')).toEqual([
      ['dropPeer', 1],
      ['dropPeer', 3],
    ]);
    expect(warnings.mock.calls).toEqual([
      ['A guest was turned away from the shared plan: INVALID_IDENTIFIER.'],
    ]);
    expect(
      host.state.participants.map((participant) => [participant.name, participant.canEdit]),
    ).toEqual([
      ['Camille', true],
      ['Léa', true],
    ]);
  });

  it('turns away a guest once the plan is full, forgetting its connection', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = side(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)), ['camille']);
    await named(host.state, 'Camille');
    await host.state.share();
    for (let peer = 1; peer <= MAX_PARTICIPANTS; peer += 1) {
      emit(host.collaboration, {
        kind: 'peerJoined',
        peer,
        participantId: `p${String(peer)}`,
        name: 'Someone',
        endpoint: ENDPOINT,
        tokenDigest: 'd'.repeat(64),
      });
    }
    expect([host.state.participants.length, warnings.mock.calls]).toEqual([
      MAX_PARTICIPANTS,
      [['A guest was turned away from the shared plan: ROSTER_FULL.']],
    ]);
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 99,
      participantId: `p${String(MAX_PARTICIPANTS)}`,
      name: 'Again',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    expect(host.collaboration.requests.filter(([name]) => name === 'dropPeer')).toEqual([
      ['dropPeer', MAX_PARTICIPANTS],
      ['dropPeer', 99],
    ]);
  });

  it('removes a guest who left, ignoring guests it does not know', async () => {
    const { host } = await sharedPair();
    expect([host.state.joinedAt(LEA), host.state.joinedAt(HOST_ID)]).toEqual([JOINED_AT, null]);
    emit(host.collaboration, { kind: 'peerLeft', peer: 9 });
    emit(host.collaboration, { kind: 'peerMessage', peer: 9, message: Uint8Array.of(1) });
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    expect(host.state.participants.map((participant) => participant.name)).toEqual(['Camille']);
    expect(host.state.joinedAt(LEA)).toBeNull();
  });

  it('tells the others a new name and keeps it, and keeps the old one when it cannot be kept', async () => {
    const { host, guest, relay } = await sharedPair();
    expect(await guest.state.rename('Léa M.')).toEqual({ ok: true, value: null });
    await relay();
    host.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await host.state.rename('Cam')).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
    await settle();
    expect([
      host.state.participants.map((participant) => participant.name),
      host.state.settings?.name,
      host.collaboration.sent,
    ]).toEqual([['Camille', 'Léa M.'], 'Camille', []]);
  });

  it('copies the code of the plan through the main process, telling whether it could', async () => {
    const { host } = await sharedPair();
    expect(await host.state.copyCode()).toBe(true);
    host.collaboration.copyResult = { ok: false, error: { code: 'TASK_FAILED' } };
    expect(await host.state.copyCode()).toBe(false);
    expect(host.collaboration.requests.filter(([kind]) => kind === 'copyCode')).toEqual([
      ['copyCode'],
      ['copyCode'],
    ]);
  });

  it('shows the new code drawn after too many wrong ones, only while hosting', async () => {
    const { host, guest } = await sharedPair();
    emit(host.collaboration, { kind: 'codeChanged', code: 'ABCDEF' });
    emit(guest.collaboration, { kind: 'codeChanged', code: 'ABCDEF' });
    expect(host.state.mode.kind === 'hosting' && host.state.mode.sharing.code).toBe('ABCDEF');
    expect(guest.state.mode).toEqual({ kind: 'guest', connection: 'connected' });
  });

  it('ignores the events of a side the page does not hold', () => {
    const page = side(null, []);
    emit(page.collaboration, {
      kind: 'peerJoined',
      peer: 1,
      participantId: 'lea',
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    emit(page.collaboration, { kind: 'peerLeft', peer: 1 });
    emit(page.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'update', update: Uint8Array.of(0, 0) }),
    });
    expect([page.state.participants, page.opened]).toEqual([[], []]);
  });

  it('logs messages it cannot read and what the shared plan refused', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host, guest } = await sharedPair();
    emit(host.collaboration, { kind: 'peerMessage', peer: 1, message: Uint8Array.of(9) });
    emit(guest.collaboration, { kind: 'hostMessage', message: Uint8Array.of(9) });
    emit(host.collaboration, {
      kind: 'peerMessage',
      peer: 1,
      message: encodeMessage({ kind: 'update', update: Uint8Array.of(1) }),
    });
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'presence', name: 'x', selectedTaskId: null }),
    });
    expect(warnings.mock.calls).toEqual([
      ['A message of a guest could not be read: UNSUPPORTED_VERSION.'],
      ['A message of the host could not be read: UNSUPPORTED_VERSION.'],
      ['The shared plan refused a message of lea: READ_ONLY.'],
      ['The shared plan refused a message: UNEXPECTED_MESSAGE.'],
    ]);
  });

  it('keeps the plan open and joined but offline when the connection ends, telling why and sending nothing more', async () => {
    const { guest } = await sharedPair();
    emit(guest.collaboration, { kind: 'ended', reason: 'BROKEN' });
    expect([
      guest.state.mode,
      guest.state.lastEnd,
      guest.state.participants.map((participant) => participant.name),
      guest.state.me,
      guest.state.isReadOnly,
      guest.state.hostName,
    ]).toEqual([
      { kind: 'guest', connection: 'lost' },
      'BROKEN',
      ['Camille', 'Léa'],
      LEA,
      true,
      'Camille',
    ]);
    expect(guest.session()).not.toBeNull();
    guest.select('a');
    rename(guest.session(), 'a', 'Offline');
    await settle();
    expect(guest.collaboration.sent).toEqual([]);
    await guest.state.stop();
    expect([guest.state.mode, guest.collaboration.requests.at(-1)]).toEqual([
      { kind: 'idle' },
      ['stop'],
    ]);
  });

  it('keeps the changes made while reconnecting and shares them once the connection comes back', async () => {
    const { host, guest, relay } = await sharedPair();
    expect(host.state.setRight(LEA, true)).toBe(true);
    await relay();
    host.select('b');
    await relay();
    expect([...guest.state.presence.keys()]).toEqual(['b']);
    emit(guest.collaboration, { kind: 'reconnecting' });
    expect([guest.state.mode, guest.state.presence.size]).toEqual([
      { kind: 'guest', connection: 'reconnecting' },
      0,
    ]);
    rename(guest.session(), 'a', 'Written while away');
    guest.select('a');
    await settle();
    expect(guest.collaboration.sent).toEqual([]);
    emit(guest.collaboration, { kind: 'offline' });
    expect(guest.state.mode).toEqual({ kind: 'guest', connection: 'offline' });
    emit(guest.collaboration, { kind: 'connected' });
    expect(guest.state.mode).toEqual({ kind: 'guest', connection: 'connected' });
    await relay();
    expect(
      host
        .session()
        ?.project()
        .tasks.find((task) => task.id === 'a')?.name,
    ).toBe('Written while away');
    expect(
      host.state.participants.find((participant) => participant.id === LEA)?.selectedTaskId,
    ).toBe('a');
  });

  it('ignores a lost connection or a new one while no plan joined is open', () => {
    const idle = side(null, []);
    emit(idle.collaboration, { kind: 'reconnecting' });
    emit(idle.collaboration, { kind: 'offline' });
    expect(idle.state.mode).toEqual({ kind: 'idle' });
  });

  it('asks once for the next host when the host leaves, giving the people from the oldest, and logs a request it could not make', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { guest } = await sharedPair();
    guest.collaboration.findNextHostResult = { ok: false, error: { code: 'TASK_FAILED' } };
    emit(guest.collaboration, { kind: 'hostLeft' });
    emit(guest.collaboration, { kind: 'offline' });
    await settle();
    expect([
      guest.state.mode,
      guest.collaboration.requests.filter(([name]) => name === 'findNextHost'),
      errors.mock.calls,
    ]).toEqual([
      { kind: 'guest', connection: 'offline' },
      [
        [
          'findNextHost',
          [{ participantId: 'lea', rank: 1, endpoint: ENDPOINT }],
          PLAN_NAME,
          'Léa',
          [
            { participantId: 'camille', tokenDigest: 'd'.repeat(64) },
            { participantId: 'lea', tokenDigest: 'd'.repeat(64) },
          ],
        ],
      ],
      [['The next host of the shared plan could not be looked for:', { code: 'TASK_FAILED' }]],
    ]);
  });

  it('hosts the plan once its turn came, the old host coming back with its rank and right, and tells who left', async () => {
    const { guest } = await sharedPair();
    emit(guest.collaboration, { kind: 'hostLeft' });
    await settle();
    emit(guest.collaboration, {
      kind: 'becameHost',
      sharing: {
        code: 'N3WC0D',
        port: 47_313,
        addresses: ['10.0.0.2'],
        tokenDigest: 'd'.repeat(64),
      },
    });
    expect([
      guest.state.mode.kind,
      guest.state.participants.map((each) => [each.name, each.isHost]),
    ]).toEqual(['hosting', [['Léa', true]]]);
    emit(guest.collaboration, {
      kind: 'peerJoined',
      peer: 1,
      participantId: 'camille',
      name: 'Camille',
      endpoint: ENDPOINT,
      tokenDigest: 'd'.repeat(64),
    });
    expect([
      guest.state.participants.map((each) => [each.name, each.rank, each.canEdit]),
      guest.hostChanges,
    ]).toEqual([
      [
        ['Léa', 1, true],
        ['Camille', 0, true],
      ],
      [['Camille', null]],
    ]);
  });

  it('tells the people of the plan who now hosts it once its first list arrives after the host left', async () => {
    const { guest } = await sharedPair();
    emit(guest.collaboration, { kind: 'hostLeft' });
    await settle();
    const me = guest.state.me ?? LEA;
    const newHost = {
      id: requireParticipantId('noah'),
      name: 'Noah',
      color: 2,
      canEdit: true,
      isHost: true,
      rank: 2,
      selectedTaskId: null,
      endpoint: null,
      tokenDigest: null,
    };
    const lea = {
      ...newHost,
      id: me,
      name: 'Léa',
      isHost: false,
      canEdit: false,
      rank: 1,
      color: 1,
    };
    emit(guest.collaboration, { kind: 'connected' });
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'participants', you: me, participants: [newHost, lea] }),
    });
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'participants', you: me, participants: [newHost, lea] }),
    });
    expect([guest.hostChanges, guest.state.hostName]).toEqual([[['Camille', 'Noah']], 'Noah']);
  });

  it('gives way to an older host: stops hosting and waits to join it as a guest, telling nobody left', async () => {
    const { host } = await sharedPair();
    emit(host.collaboration, { kind: 'yielded' });
    expect([host.state.mode, host.hostChanges]).toEqual([
      { kind: 'guest', connection: 'reconnecting' },
      [],
    ]);
    emit(host.collaboration, { kind: 'connected' });
    const sent = host.collaboration.sent.map(([to, message]) => {
      const read = readMessage(message);
      return [to, read.ok ? read.value.kind : read.error];
    });
    expect([host.state.mode, sent.at(-1)]).toEqual([
      { kind: 'guest', connection: 'connected' },
      ['host', 'stateVector'],
    ]);
  });

  it('ignores a turn to host, a request to give way or the host leaving while it does not hold the matching role', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const idle = side(null, []);
    emit(idle.collaboration, { kind: 'hostLeft' });
    emit(idle.collaboration, { kind: 'yielded' });
    emit(idle.collaboration, {
      kind: 'becameHost',
      sharing: { code: 'N3WC0D', port: 1, addresses: [], tokenDigest: 'd'.repeat(64) },
    });
    expect([idle.state.mode, idle.collaboration.requests, errors.mock.calls]).toEqual([
      { kind: 'idle' },
      [],
      [['The page cannot host the plan it was told to host.']],
    ]);
  });

  it('ends an attempt to join when the connection ends before the plan opens', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ' });
    emit(guest.collaboration, { kind: 'ended', reason: 'WRONG_CODE' });
    expect([guest.state.mode, guest.state.lastEnd, guest.state.me]).toEqual([
      { kind: 'idle' },
      'WRONG_CODE',
      null,
    ]);
  });

  it('places the other people on the task each one selected, never this page', async () => {
    const { host, guest, relay } = await sharedPair();
    guest.select('a');
    host.select('a');
    await relay();
    /** Lists the names of the people placed on each task. */
    const names = (state: CollaborationState) =>
      [...state.presence].map(([task, people]) => [task, people.map((person) => person.name)]);
    expect([names(host.state), names(guest.state)]).toEqual([
      [['a', ['Léa']]],
      [['a', ['Camille']]],
    ]);
  });

  it('stops sharing when another project is opened, and when asked', async () => {
    const { host, guest } = await sharedPair();
    host.state.attached(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)));
    await settle();
    expect([host.state.mode, host.collaboration.requests.at(-1)]).toEqual([
      { kind: 'idle' },
      ['stop'],
    ]);
    await guest.state.stop();
    await guest.state.stop();
    expect(guest.collaboration.requests.filter(([name]) => name === 'stop')).toEqual([['stop']]);
  });

  it('leaves the plan when the plan the host sent cannot be opened', async () => {
    const guest = side(null, ['lea']);
    guest.failOpening();
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: 'K7Q4MZ' });
    const state = encodeMessage({
      kind: 'update',
      update: sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)).encodeState(),
    });
    emit(guest.collaboration, { kind: 'hostMessage', message: state });
    emit(guest.collaboration, { kind: 'hostMessage', message: state });
    await settle();
    expect([guest.opened.length, guest.state.mode, guest.collaboration.requests.at(-1)]).toEqual([
      1,
      { kind: 'idle' },
      ['stop'],
    ]);
  });

  it('logs a stop the main process could not make, idle all the same', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host } = await sharedPair();
    host.collaboration.stopResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await host.state.stop();
    expect([host.state.mode, errors.mock.calls]).toEqual([
      { kind: 'idle' },
      [['The shared plan could not be stopped:', { code: 'TASK_FAILED' }]],
    ]);
  });
});

describe('the settings and the plans nearby', () => {
  it('reads and keeps the settings, giving back a failure to read or write them', async () => {
    const page = side(null, []);
    page.collaboration.settingsResult = { ok: false, error: { code: 'READ_FAILED' } };
    expect(await page.state.saveSettings({ name: 'Léa' })).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    expect(page.state.settings).toBeNull();
    page.collaboration.settingsResult = {
      ok: true,
      value: { name: null, port: 47_313, firewallNoticeSeen: false },
    };
    page.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await page.state.saveSettings({ name: 'Léa' })).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(page.state.settings).toEqual({ name: null, port: 47_313, firewallNoticeSeen: false });
  });

  it('lists the plans nearby while searching, and forgets them once it stops', async () => {
    const page = side(null, []);
    await page.state.findPlans(true);
    const plan = {
      key: 'k',
      planName: 'Thesis',
      hostName: 'Camille',
      addresses: ['10.0.0.1'],
      port: 1,
    };
    emit(page.collaboration, { kind: 'nearbyPlans', plans: [plan] });
    expect(page.state.nearbyPlans).toEqual([plan]);
    await page.state.findPlans(false);
    expect([page.state.nearbyPlans, page.collaboration.requests]).toEqual([
      [],
      [
        ['findPlans', true],
        ['findPlans', false],
      ],
    ]);
  });

  it('logs a search that could not change', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = side(null, []);
    page.collaboration.findPlansResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await page.state.findPlans(true);
    expect(errors.mock.calls).toEqual([
      ['The search for shared plans could not change:', { code: 'TASK_FAILED' }],
    ]);
  });

  it('keeps settings already read when changing them', async () => {
    const page = side(null, []);
    await named(page.state, 'Léa');
    await named(page.state, 'Léa B.');
    expect([
      page.state.settings?.name,
      page.collaboration.requests.filter(([name]) => name === 'settings'),
    ]).toEqual(['Léa B.', [['settings']]]);
  });
});

describe('joining and editing together', () => {
  it('is in read only while joining, before knowing the host', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: 'K7Q4MZ' });
    expect([guest.state.mode, guest.state.isReadOnly, guest.state.hostName]).toEqual([
      { kind: 'joining' },
      true,
      null,
    ]);
  });

  it('gives back why the main process could not join, staying idle', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    guest.collaboration.joinResult = { ok: false, error: { code: 'ALREADY_SHARING' } };
    expect(await guest.state.join({ address: 'a', port: 1, code: 'K7Q4MZ' })).toEqual({
      ok: false,
      error: { code: 'ALREADY_SHARING' },
    });
    expect([guest.state.mode, guest.state.me]).toEqual([{ kind: 'idle' }, null]);
  });

  it('tells the page the repairs a merge needed, as when two people close a loop of links', async () => {
    const { host, guest, relay } = await sharedPair();
    host.state.setRight(LEA, true);
    await relay();
    expect(guest.session()?.apply({ type: 'putDependency', dependency: link('a', 'b') }).ok).toBe(
      true,
    );
    expect(host.session()?.apply({ type: 'putDependency', dependency: link('b', 'a') }).ok).toBe(
      true,
    );
    await relay();
    expect([host.repairs.length + guest.repairs.length > 0, guest.session()?.project()]).toEqual([
      true,
      host.session()?.project(),
    ]);
    expect(host.session()?.project().dependencies).toHaveLength(1);
  });

  it('tells in the log that changes made in read only stay on this computer', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { guest, relay } = await sharedPair();
    rename(guest.session(), 'a', 'Mine');
    emit(guest.collaboration, { kind: 'connected' });
    await relay();
    expect(warnings.mock.calls).toEqual([['Changes made in read only stay on this computer.']]);
  });

  it('sends the presence once for several selections in a row, and none without a name', async () => {
    const { host, guest, relay } = await sharedPair();
    guest.select('a');
    guest.select('b');
    await settle();
    expect(guest.collaboration.sent).toHaveLength(1);
    await relay();
    expect(await host.state.saveSettings({ name: null })).toEqual({ ok: true, value: null });
    host.select('a');
    await settle();
    expect(host.collaboration.sent).toEqual([]);
  });
});
