import { testDigest, testJoinCode } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage, readMessage } from '../../core/collaboration/messages';
import { requireParticipantId } from '../../core/collaboration/participants';
import { MAX_DEPARTED_PARTICIPANTS, MAX_PARTICIPANTS } from '../../core/limits';
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
  const relayTold: unknown[][] = [];
  const kept: unknown[] = [];
  let openSucceeds = true;
  let openingError: Error | null = null;
  const laterShares: (() => void)[] = [];
  let sharesAtOnce = true;
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
      if (openingError !== null) {
        return Promise.reject(openingError);
      }
      opened.push(bytes);
      const read = openSharedSessionFromState(bytes);
      if (!openSucceeds || !read.ok) {
        return Promise.resolve(false);
      }
      current = read.value;
      state.attached(read.value);
      return Promise.resolve(true);
    },
    openJoined: (project) => {
      opened.push(project.state);
      const read = openSharedSessionFromState(project.state);
      if (!openSucceeds || !read.ok) {
        return Promise.resolve(false);
      }
      current = read.value;
      state.attached(read.value);
      return Promise.resolve(true);
    },
    repaired: (found) => repairs.push(...found),
    hostChanged: ({ left, next }) => hostChanges.push([left, next]),
    ownChangesKept: (result) => kept.push(result),
    selectedTaskId: () => (selected === null ? null : testId(selected)),
    relayEnded: (reason, relay) => relayTold.push(['ended', reason, relay]),
    relayLinkNotKept: () => relayTold.push(['linkNotKept']),
    relayChangeRefused: () => relayTold.push(['changeRefused']),
    relayNotReopened: () => relayTold.push(['notReopened']),
    shareLater: (share) => {
      laterShares.push(share);
      if (sharesAtOnce) {
        laterShares.splice(0).forEach((each) => {
          each();
        });
      }
    },
  });
  return {
    state,
    bridge,
    collaboration: control.collaboration,
    opened,
    repairs,
    hostChanges,
    kept,
    relayTold,
    session: () => current,
    select: (id: string | null) => {
      selected = id;
      state.selectionChanged();
    },
    failOpening: () => {
      openSucceeds = false;
    },
    failOpeningWith: (error: Error) => {
      openingError = error;
    },
    holdShares: () => {
      sharesAtOnce = false;
    },
    laterShares,
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
  expect(
    await guest.state.join({ address: '192.168.1.24', port: 47_313, code: testJoinCode('K7Q4MZ') }),
  ).toEqual({
    ok: true,
    value: null,
  });
  emit(host.collaboration, {
    kind: 'peerJoined',
    peer: 1,
    participantId: requireParticipantId('lea'),
    name: 'Léa',
    endpoint: ENDPOINT,
    tokenDigest: testDigest('d'.repeat(64)),
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

/** Reads the names of the tasks in a state sent to the main process, in alphabetical order. */
function taskNamesIn(state: unknown): readonly string[] {
  if (!(state instanceof Uint8Array)) {
    throw new Error('No plan was sent');
  }
  const opened = openSharedSessionFromState(state);
  if (!opened.ok) {
    throw new Error('The plan sent cannot be opened');
  }
  return opened.value
    .project()
    .tasks.map((task) => task.name)
    .sort();
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
    expect(
      await nameless.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') }),
    ).toEqual({
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
        code: testJoinCode('K7Q4MZ'),
        port: 47_313,
        addresses: ['192.168.1.24'],
        tokenDigest: testDigest('d'.repeat(64)),
      },
    });
    expect(guest.collaboration.requests.find(([name]) => name === 'join')).toEqual([
      'join',
      {
        address: '192.168.1.24',
        port: 47_313,
        code: testJoinCode('K7Q4MZ'),
        participantId: 'lea',
        name: 'Léa',
      },
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
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
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
    await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
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

  it('takes back a person whose old connection the main process closed, keeping the right', async () => {
    const { host } = await sharedPair();
    expect(host.state.setRight(LEA, true)).toBe(true);
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 2,
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
    });
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    expect(
      host.collaboration.requests.filter(
        ([name]) => name === 'dropPeer' || name === 'allowPeerToEdit',
      ),
    ).toEqual([
      ['allowPeerToEdit', 1],
      ['allowPeerToEdit', 2],
    ]);
    expect(
      host.state.participants.map((participant) => [participant.name, participant.canEdit]),
    ).toEqual([
      ['Camille', true],
      ['Léa', true],
    ]);
  });

  it('refuses a second share while the first one starts, and hosts nothing when the page opened another plan meanwhile', async () => {
    const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
    const host = side(sessionOn(origin, 1), ['camille', 'again']);
    await named(host.state, 'Camille');
    const first = host.state.share();
    expect(await host.state.share()).toEqual({ ok: false, error: { code: 'ALREADY_SHARING' } });
    host.state.attached(sessionOn(origin, 2));
    expect([await first, host.state.mode, host.collaboration.requests.at(-1)]).toEqual([
      { ok: false, error: { code: 'CANCELLED' } },
      { kind: 'idle' },
      ['stop'],
    ]);
  });

  it('joins nothing when the page stopped while the join started', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    let answer: (result: { ok: true; value: null }) => void = () => undefined;
    Object.assign(guest.bridge, {
      joinPlan: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const joining = guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
    await settle();
    await guest.state.stop();
    answer({ ok: true, value: null });
    expect([await joining, guest.state.mode]).toEqual([
      { ok: false, error: { code: 'CANCELLED' } },
      { kind: 'idle' },
    ]);
  });

  it('logs a guest the main process could not let send its changes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host } = await sharedPair();
    host.collaboration.allowResult = { ok: false, error: { code: 'TASK_FAILED' } };
    expect(host.state.setRight(LEA, true)).toBe(true);
    await settle();
    expect(errors.mock.calls).toEqual([
      ['A guest could not be let to send its changes:', { code: 'TASK_FAILED' }],
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
        participantId: requireParticipantId(`p${String(peer)}`),
        name: 'Someone',
        endpoint: ENDPOINT,
        tokenDigest: testDigest('d'.repeat(64)),
      });
    }
    expect([host.state.participants.length, warnings.mock.calls]).toEqual([
      MAX_PARTICIPANTS,
      [['A guest was turned away from the shared plan: ROSTER_FULL.']],
    ]);
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 99,
      participantId: requireParticipantId(`p${String(MAX_PARTICIPANTS)}`),
      name: 'Again',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
    });
    expect(host.collaboration.requests.filter(([name]) => name === 'dropPeer')).toEqual([
      ['dropPeer', MAX_PARTICIPANTS],
      ['dropPeer', 99],
    ]);
    expect(host.collaboration.requests.filter(([name]) => name === 'forgetGuests')).toEqual([
      ['forgetGuests', [`p${String(MAX_PARTICIPANTS)}`]],
      ['forgetGuests', [`p${String(MAX_PARTICIPANTS)}`]],
    ]);
  });

  it('has the main process forget a guest once the list of people forgets it, and logs a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = side(sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)), ['camille']);
    await named(host.state, 'Camille');
    await host.state.share();
    host.collaboration.forgetResult = { ok: false, error: { code: 'TASK_FAILED' } };
    for (let peer = 1; peer <= MAX_DEPARTED_PARTICIPANTS + 1; peer += 1) {
      emit(host.collaboration, {
        kind: 'peerJoined',
        peer,
        participantId: requireParticipantId(`p${String(peer)}`),
        name: 'Someone',
        endpoint: ENDPOINT,
        tokenDigest: testDigest('d'.repeat(64)),
      });
      emit(host.collaboration, { kind: 'peerLeft', peer });
    }
    await settle();
    expect([
      host.collaboration.requests.filter(([name]) => name === 'forgetGuests'),
      errors.mock.calls,
    ]).toEqual([
      [['forgetGuests', ['p1']]],
      [['The guests the plan forgot could not be forgotten:', { code: 'TASK_FAILED' }]],
    ]);
  });

  it('sends a change of the host to all its guests in one message, and nothing when none is connected', async () => {
    const { host } = await sharedPair();
    host.collaboration.sent.splice(0);
    rename(host.session(), 'a', 'For everyone');
    const targets = host.collaboration.sent.map(([to]) => to);
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    host.collaboration.sent.splice(0);
    rename(host.session(), 'a', 'For nobody');
    expect([targets, host.collaboration.sent]).toEqual([[[1]], []]);
  });

  it('removes a guest who left, ignoring guests it does not know and logging their messages', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = await sharedPair();
    expect([host.state.joinedAt(LEA), host.state.joinedAt(HOST_ID)]).toEqual([JOINED_AT, null]);
    emit(host.collaboration, { kind: 'peerLeft', peer: 9 });
    emit(host.collaboration, { kind: 'peerMessage', peer: 9, message: Uint8Array.of(1) });
    emit(host.collaboration, { kind: 'peerLeft', peer: 1 });
    expect(warnings.mock.calls).toEqual([
      ['A message came from a guest no longer in the shared plan.'],
    ]);
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
    emit(host.collaboration, { kind: 'codeChanged', code: testJoinCode('ABCDEF') });
    emit(guest.collaboration, { kind: 'codeChanged', code: testJoinCode('ABCDEF') });
    expect(host.state.mode.kind === 'hosting' && host.state.mode.sharing.code).toBe('ABCDEF');
    expect(guest.state.mode).toEqual({ kind: 'guest', connection: 'connected' });
  });

  it('ignores the events of a side the page does not hold', () => {
    const page = side(null, []);
    emit(page.collaboration, {
      kind: 'peerJoined',
      peer: 1,
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
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
      message: encodeMessage({
        kind: 'presence',
        name: requireParticipantId('x'),
        selectedTaskId: null,
      }),
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
      false,
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

  it('asks once for the next host when the host leaves, giving the people allowed to edit from the oldest, and leaves the plan, logging why, when the request could not be made', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host, guest, relay } = await sharedPair();
    expect(host.state.setRight(LEA, true)).toBe(true);
    await relay();
    guest.collaboration.findNextHostResult = { ok: false, error: { code: 'TASK_FAILED' } };
    emit(guest.collaboration, { kind: 'hostLeft' });
    emit(guest.collaboration, { kind: 'offline' });
    await settle();
    expect([
      guest.state.mode,
      guest.collaboration.requests.filter(([name]) => name === 'findNextHost'),
      errors.mock.calls,
    ]).toEqual([
      { kind: 'guest', connection: 'lost' },
      [
        [
          'findNextHost',
          [{ participantId: requireParticipantId('lea'), rank: 1, endpoint: ENDPOINT }],
          PLAN_NAME,
          'Léa',
          [
            {
              participantId: 'camille',
              tokenDigest: testDigest('d'.repeat(64)),
              rank: 0,
              canEdit: true,
            },
            {
              participantId: 'lea',
              tokenDigest: testDigest('d'.repeat(64)),
              rank: 1,
              canEdit: true,
            },
          ],
        ],
      ],
      [
        ['The next host of the shared plan could not be looked for:', { code: 'TASK_FAILED' }],
        ['The shared plan is left, its next host not being looked for.'],
      ],
    ]);
  });

  it('hosts the plan once its turn came, the old host coming back with its rank and right, and tells who left', async () => {
    const { guest } = await sharedPair();
    emit(guest.collaboration, { kind: 'hostLeft' });
    await settle();
    emit(guest.collaboration, {
      kind: 'becameHost',
      sharing: {
        code: testJoinCode('N3WC9D'),
        port: 47_313,
        addresses: ['10.0.0.2'],
        tokenDigest: testDigest('d'.repeat(64)),
      },
    });
    expect([
      guest.state.mode.kind,
      guest.state.participants.map((each) => [each.name, each.isHost]),
    ]).toEqual(['hosting', [['Léa', true]]]);
    emit(guest.collaboration, {
      kind: 'peerJoined',
      peer: 1,
      participantId: requireParticipantId('camille'),
      name: 'Camille',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
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

  it('follows a lost connection and the host leaving while it waits for the whole plan again after keeping changes apart', async () => {
    const { guest } = await sharedPair();
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'refused' }),
    });
    await settle();
    emit(guest.collaboration, { kind: 'reconnecting' });
    const reconnecting = guest.state.mode;
    emit(guest.collaboration, { kind: 'hostLeft' });
    await settle();
    expect([
      guest.kept.length,
      reconnecting,
      guest.collaboration.requests.filter(([name]) => name === 'findNextHost').length,
    ]).toEqual([1, { kind: 'guest', connection: 'reconnecting' }, 1]);
  });

  it('ignores a request to give way or the host leaving while it does not hold the matching role, and stops a turn to host it cannot take', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const idle = side(null, []);
    emit(idle.collaboration, { kind: 'hostLeft' });
    emit(idle.collaboration, { kind: 'yielded' });
    emit(idle.collaboration, {
      kind: 'becameHost',
      sharing: {
        code: testJoinCode('N3WC9D'),
        port: 1,
        addresses: [],
        tokenDigest: testDigest('d'.repeat(64)),
      },
    });
    expect([idle.state.mode, idle.collaboration.requests, errors.mock.calls]).toEqual([
      { kind: 'idle' },
      [['stop']],
      [['The page cannot host the plan it was told to host.']],
    ]);
  });

  it('ends an attempt to join when the connection ends before the plan opens', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: '192.168.1.24', port: 47_313, code: testJoinCode('K7Q4MZ') });
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

  it('opens the whole plan the host sent in answer, not a change of the plan that came before it', async () => {
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
    const whole = sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)).encodeState();
    for (const message of [
      { kind: 'update', update: Uint8Array.of(1, 2) },
      { kind: 'update', update: whole },
      { kind: 'stateVector', vector: Uint8Array.of(0) },
    ] as const) {
      emit(guest.collaboration, { kind: 'hostMessage', message: encodeMessage(message) });
    }
    await settle();
    expect(guest.opened).toEqual([whole]);
  });

  it('leaves the plan, logging why, when opening the plan the host sent fails unexpectedly', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const guest = side(null, ['lea']);
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
    const failed = new Error('opening broke');
    guest.failOpeningWith(failed);
    const whole = sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)).encodeState();
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'update', update: whole }),
    });
    emit(guest.collaboration, {
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) }),
    });
    await settle();
    expect([guest.state.mode, errors.mock.calls]).toEqual([
      { kind: 'idle' },
      [['The plan the host sent could not be opened:', failed]],
    ]);
  });

  it('logs a guest turned away that the main process could not drop', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = await sharedPair();
    host.collaboration.dropResult = { ok: false, error: { code: 'TASK_FAILED' } };
    emit(host.collaboration, {
      kind: 'peerJoined',
      peer: 3,
      participantId: requireParticipantId('camille'),
      name: 'Fake',
      endpoint: ENDPOINT,
      tokenDigest: testDigest('d'.repeat(64)),
    });
    await settle();
    expect(errors.mock.calls).toEqual([
      ['A guest turned away could not be dropped:', { code: 'TASK_FAILED' }],
    ]);
  });

  it('leaves the plan when the plan the host sent cannot be opened', async () => {
    const guest = side(null, ['lea']);
    guest.failOpening();
    await named(guest.state, 'Léa');
    await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
    const state = encodeMessage({
      kind: 'update',
      update: sessionOn(createSharedDocument(project([]), TEST_DOCUMENT_ID)).encodeState(),
    });
    const vector = encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) });
    emit(guest.collaboration, { kind: 'hostMessage', message: state });
    emit(guest.collaboration, { kind: 'hostMessage', message: vector });
    emit(guest.collaboration, { kind: 'hostMessage', message: state });
    emit(guest.collaboration, { kind: 'hostMessage', message: vector });
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
      value: { name: null, port: 47_313, firewallNoticeSeen: false, relayAddress: null },
    };
    page.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await page.state.saveSettings({ name: 'Léa' })).toEqual({
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    expect(page.state.settings).toEqual({
      name: null,
      port: 47_313,
      firewallNoticeSeen: false,
      relayAddress: null,
    });
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
    await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') });
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
    expect(await guest.state.join({ address: 'a', port: 1, code: testJoinCode('K7Q4MZ') })).toEqual(
      {
        ok: false,
        error: { code: 'ALREADY_SHARING' },
      },
    );
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

  it('lets a person in read only change the plan only while away from the host', async () => {
    const { guest } = await sharedPair();
    const readOnly = [guest.state.isReadOnly];
    emit(guest.collaboration, { kind: 'reconnecting' });
    readOnly.push(guest.state.isReadOnly);
    emit(guest.collaboration, { kind: 'offline' });
    readOnly.push(guest.state.isReadOnly);
    emit(guest.collaboration, { kind: 'ended', reason: 'IDENTITY_TAKEN' });
    readOnly.push(guest.state.isReadOnly);
    expect(readOnly).toEqual([true, false, false, false]);
  });

  it('keeps apart the changes made in read only away from the host, then shows the shared plan again and follows it', async () => {
    const { host, guest, relay } = await sharedPair();
    emit(guest.collaboration, { kind: 'reconnecting' });
    rename(guest.session(), 'a', 'Mine');
    rename(host.session(), 'b', 'Changed by the host');
    emit(guest.collaboration, { kind: 'connected' });
    await relay();
    const request = guest.collaboration.requests.find(([name]) => name === 'keepOwnChanges');
    expect([
      request?.[2],
      taskNamesIn(request?.[1]),
      guest.kept,
      guest.opened.length,
      guest.state.mode,
      guest.state.isReadOnly,
      guest.session()?.project(),
    ]).toEqual([
      PLAN_NAME,
      ['Changed by the host', 'Mine'],
      [{ ok: true, value: { planName: PLAN_NAME, localCopySaved: true } }],
      2,
      { kind: 'guest', connection: 'connected' },
      true,
      host.session()?.project(),
    ]);
    rename(host.session(), 'a', 'Shared again');
    await relay();
    expect(guest.session()?.project()).toEqual(host.session()?.project());
  });

  it('keeps the changes in the plan open here when they cannot be kept apart, telling it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { guest, relay } = await sharedPair();
    guest.collaboration.keepResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    emit(guest.collaboration, { kind: 'reconnecting' });
    rename(guest.session(), 'a', 'Mine');
    emit(guest.collaboration, { kind: 'connected' });
    await relay();
    expect([
      guest.kept,
      errors.mock.calls,
      guest.opened.length,
      guest
        .session()
        ?.project()
        .tasks.find((task) => task.id === 'a')?.name,
    ]).toEqual([
      [{ ok: false, error: { code: 'WRITE_FAILED' } }],
      [['The changes made in read only could not be kept apart:', { code: 'WRITE_FAILED' }]],
      1,
      'Mine',
    ]);
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

describe('a plan shared through a relay, seen from the page', () => {
  const origin = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);

  it('comes back to the relay of a plan opened with a kept link, following its events, in read only with the link that reads, and leaves it once stopped', async () => {
    const session = sessionOn(origin, 1);
    const reader = side(session, []);
    reader.collaboration.relay.reopenResult = {
      ok: true,
      value: {
        shown: { edit: null, view: 'tasklace://relay.example.org/#v1.P0dX8w…' },
        relay: 'relay.example.org',
      },
    };
    reader.state.attached(session);
    await settle();
    emit(reader.collaboration, { kind: 'relayConnected', member: 2, members: [] });
    const connected = reader.state.relay.connection;
    emit(reader.collaboration, { kind: 'offline' });
    const offline = reader.state.relay.connection;
    const readOnly = reader.state.isReadOnly;
    await reader.state.stop();
    expect([
      reader.collaboration.relay.requests,
      connected,
      offline,
      readOnly,
      reader.state.relay.isActive,
      reader.collaboration.requests.at(-1),
    ]).toEqual([
      [['reopenSharedPlan', TEST_DOCUMENT_ID]],
      'connected',
      'offline',
      true,
      false,
      ['stop'],
    ]);
  });

  it('joins a plan by its link, opening the plan the main process offered and sending its own changes', async () => {
    const joiner = side(null, []);
    await named(joiner.state, 'Léa');
    joiner.collaboration.relay.joinResult = {
      ok: true,
      value: {
        project: {
          state: sessionOn(origin, 2).encodeState(),
          documentId: TEST_DOCUMENT_ID,
          fileName: '',
          warnings: [],
          localChanges: null,
        },
        shown: {
          edit: 'tasklace://relay.example.org/#e1.Hq7Lm2…',
          view: 'tasklace://relay.example.org/#v1.P0dX8w…',
        },
        relay: 'relay.example.org',
        bytesSinceSnapshot: 0,
        kept: true,
      },
    };
    const answer = await joiner.state.relay.join('tasklace://relay.example.org/#e1.key');
    rename(joiner.session(), 'a', 'Mine');
    await settle();
    expect([
      answer,
      joiner.opened.length,
      joiner.collaboration.relay.sent.map((outgoing) =>
        outgoing.kind === 'message' ? outgoing.message.kind : outgoing.kind,
      ),
    ]).toEqual([{ ok: true, value: null }, 1, ['presence', 'update']]);
  });

  it('warns about an event of a relay when the page shares nothing through one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const idle = side(sessionOn(origin, 1), []);
    emit(idle.collaboration, { kind: 'relayCaughtUp' });
    expect(warn.mock.calls).toEqual([
      ['An event of a plan shared through a relay came while none is: relayCaughtUp.'],
    ]);
  });
});
