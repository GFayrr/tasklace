import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSharedDocument } from '../shared/shared-document';
import type { SharedSession } from '../shared/shared-session';
import { CONVERGENCE_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { sessionOn } from '../testing/session-copy';
import type { CollaborationMessage } from './messages';
import { requireParticipantId, type ParticipantId } from './participants';
import { takeOverRoster } from './roster';
import { createGuest, createHost, type Guest, type Host } from './sync';

const HOST = requireParticipantId('host');
const READER = requireParticipantId('ines');
const TASK_IDS = ['a', 'b', 'c'];
const READER_MARK = 'R';
const MAX_STEPS = 60;
const MAX_QUEUE_POSITION = 50;
const MAX_MARK = 99;
const PACKETS_PER_GUEST_AND_STEP = 64;
const FEW_EDITORS = 2;
const LARGEST_TESTED_TEAM = 25;

type Packet =
  | { readonly toHost: true; readonly from: ParticipantId; readonly message: CollaborationMessage }
  | { readonly toHost: false; readonly to: ParticipantId; readonly message: CollaborationMessage };

type Step =
  | { readonly kind: 'edit'; readonly actor: number; readonly task: number; readonly mark: number }
  | { readonly kind: 'deliver' | 'duplicate' | 'drop'; readonly at: number }
  | { readonly kind: 'reconnect' | 'rejoin'; readonly guest: number }
  | { readonly kind: 'grant' | 'revoke'; readonly guest: number }
  | { readonly kind: 'forge' }
  | { readonly kind: 'hostLeaves' };

/** Builds the steps of a scenario for a host and a number of guests, the last guest being in read only. */
function stepArbitrary(guestCount: number): fc.Arbitrary<Step> {
  return fc.oneof(
    fc.record({
      kind: fc.constant('edit' as const),
      actor: fc.nat({ max: guestCount }),
      task: fc.nat({ max: TASK_IDS.length - 1 }),
      mark: fc.nat({ max: MAX_MARK }),
    }),
    fc.record({
      kind: fc.constantFrom('deliver', 'duplicate', 'drop'),
      at: fc.nat({ max: MAX_QUEUE_POSITION }),
    }),
    fc.record({
      kind: fc.constantFrom('reconnect', 'rejoin', 'grant', 'revoke'),
      guest: fc.nat({ max: guestCount - 1 }),
    }),
    fc.constant({ kind: 'forge' as const }),
    fc.constant({ kind: 'hostLeaves' as const }),
  );
}

/** Names a number of guests who may edit. */
function editorsOf(count: number): ParticipantId[] {
  return Array.from({ length: count }, (_, index) =>
    requireParticipantId(`editor-${String(index)}`),
  );
}

/** Renames a task of a session to a name marking who changed it, the session refusing nothing a test plan holds. */
function rename(session: SharedSession, index: number, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === TASK_IDS[index]);
  if (task !== undefined) {
    session.apply({ type: 'putTask', task: { ...task, name } });
  }
}

/** Plays a scenario of a host, editors and one reader, with rights changed, guests rejoining and the host leaving for the oldest editor, then checks that every editor left has the plan of the host and that no change of the reader got in. */
function playScenario(editors: readonly ParticipantId[], steps: readonly Step[]): void {
  const origin = createSharedDocument(
    project(TASK_IDS.map((id) => workTask(id))),
    TEST_DOCUMENT_ID,
  );
  const queue: Packet[] = [];
  const ids = [...editors, READER];
  const maxDeliveries = PACKETS_PER_GUEST_AND_STEP * ids.length * (MAX_STEPS + 1);
  const guests = new Map<ParticipantId, { guest: Guest; session: SharedSession }>();
  const revoked = new Set<ParticipantId>();
  /** Starts the host of the plan on a session, with the list of people it took over or a new one. */
  const startHost = (
    session: SharedSession,
    hostId: ParticipantId,
    roster: ReturnType<Host['roster']> | null,
  ): Host =>
    createHost({
      session,
      roster,
      tokenDigest: null,
      hostId,
      name: hostId,
      send: ({ to, message }) => queue.push({ toHost: false, to, message }),
      report: () => undefined,
    });
  let hostSession = sessionOn(origin, 1);
  let host = startHost(hostSession, HOST, null);
  ids.forEach((id, index) => {
    const session = sessionOn(origin, index + 2);
    const guest = createGuest({
      session,
      send: (message) => queue.push({ toHost: true, from: id, message }),
      report: () => undefined,
    });
    guests.set(id, { guest, session });
  });
  /** Hands a packet to its receiver. */
  const deliver = (packet: Packet): void => {
    if (packet.toHost) {
      host.receive(packet.from, packet.message);
    } else {
      guests.get(packet.to)?.guest.receive(packet.message);
    }
  };
  /** Delivers every queued packet in order until the network is quiet. */
  const drain = (): void => {
    for (let count = 0; queue.length > 0; count += 1) {
      if (count > maxDeliveries) {
        throw new Error('The network never became quiet.');
      }
      const packet = queue.shift();
      if (packet !== undefined) {
        deliver(packet);
      }
    }
  };
  /** Connects a guest to the current host, as a new connection of that person does. */
  const join = (id: ParticipantId): void => {
    expect(host.connect(id, id, null, null).ok).toBe(true);
    guests.get(id)?.guest.connected();
  };
  ids.forEach(join);
  editors.forEach((id) => {
    expect(host.setRight(id, true).ok).toBe(true);
  });
  drain();
  /** Lets one person change a task, marked so that a change of the guest in read only can be found. */
  const edit = (step: Extract<Step, { kind: 'edit' }>): void => {
    const actor = step.actor === 0 ? undefined : ids[step.actor - 1];
    const session = actor === undefined ? hostSession : guests.get(actor)?.session;
    const mark = actor === READER ? READER_MARK : String(step.actor);
    if (session !== undefined) {
      rename(session, step.task, `${mark}${String(step.mark)}`);
    }
  };
  /** Sends the host the whole copy of the guest in read only, as a tampered guest could. */
  const forge = (): void => {
    const reader = guests.get(READER)?.session;
    if (reader !== undefined) {
      queue.push({
        toHost: true,
        from: READER,
        message: { kind: 'update', update: reader.encodeState() },
      });
    }
  };
  /** Delivers, repeats or loses one queued packet, chosen by its position. */
  const handle = (step: Extract<Step, { kind: 'deliver' | 'duplicate' | 'drop' }>): void => {
    const [packet] = queue.splice(step.at % Math.max(queue.length, 1), 1);
    if (packet === undefined || step.kind === 'drop') {
      return;
    }
    deliver(packet);
    if (step.kind === 'duplicate') {
      queue.push(packet);
    }
  };
  /** Ends the connection of a guest and opens a new one, on its side only or, for a rejoin, on the side of the host too. */
  const reconnect = (step: Extract<Step, { kind: 'reconnect' | 'rejoin' }>): void => {
    const id = ids[step.guest] ?? READER;
    const entry = guests.get(id);
    if (entry === undefined) {
      return;
    }
    entry.guest.disconnected();
    if (step.kind === 'rejoin') {
      host.disconnect(id);
      join(id);
      return;
    }
    entry.guest.connected();
  };
  /** Takes the right to edit from a guest who may edit, or gives it back, the guest in read only keeping its right. */
  const setRight = (step: Extract<Step, { kind: 'grant' | 'revoke' }>): void => {
    const id = editors[step.guest % editors.length];
    if (id === undefined || !guests.has(id)) {
      return;
    }
    host.setRight(id, step.kind === 'grant');
    if (step.kind === 'grant') {
      revoked.delete(id);
    } else {
      revoked.add(id);
    }
  };
  /** Lets the host leave for good, the oldest guest still in taking over its list and every other guest joining it, as long as two editors remain. */
  const hostLeaves = (): void => {
    const next = editors.find((id) => guests.has(id));
    const entry = next === undefined ? undefined : guests.get(next);
    const roster = next === undefined ? null : takeOverRoster(host.roster(), next);
    if (next === undefined || entry === undefined || roster === null) {
      return;
    }
    if (editors.filter((id) => guests.has(id)).length < FEW_EDITORS) {
      return;
    }
    host.stop();
    queue.length = 0;
    guests.delete(next);
    entry.guest.stop();
    hostSession = entry.session;
    host = startHost(hostSession, next, roster);
    for (const [id, other] of guests) {
      other.guest.disconnected();
      join(id);
    }
  };
  /** Runs one step of the scenario. */
  const run = (step: Step): void => {
    if (step.kind === 'edit') {
      edit(step);
    } else if (step.kind === 'forge') {
      forge();
    } else if (step.kind === 'hostLeaves') {
      hostLeaves();
    } else if ('at' in step) {
      handle(step);
    } else if (step.kind === 'reconnect' || step.kind === 'rejoin') {
      reconnect({ kind: step.kind, guest: step.guest });
    } else {
      setRight({ kind: step.kind, guest: step.guest });
    }
  };
  steps.forEach(run);
  drain();
  revoked.forEach((id) => {
    if (guests.has(id)) {
      host.setRight(id, true);
    }
  });
  guests.forEach((entry) => {
    entry.guest.disconnected();
    entry.guest.connected();
  });
  drain();
  const expected = hostSession.project();
  for (const id of editors.filter((editor) => guests.has(editor))) {
    expect(guests.get(id)?.session.project()).toEqual(expected);
  }
  expect(expected.tasks.some((task) => task.name.startsWith(READER_MARK))).toBe(false);
}

describe('a shared plan over an unreliable network', () => {
  it(
    'ends the same for the host and every guest who may edit, whatever is lost, repeated or reordered, without any change of a guest in read only even when it forges one',
    { timeout: CONVERGENCE_TEST_TIMEOUT_MS },
    () => {
      const editors = editorsOf(FEW_EDITORS);
      fc.assert(
        fc.property(
          fc.array(stepArbitrary(editors.length + 1), { maxLength: MAX_STEPS }),
          (steps) => {
            playScenario(editors, steps);
          },
        ),
      );
    },
  );

  it(
    'ends the same for a host and the largest tested team of guests, all but one able to edit',
    { timeout: CONVERGENCE_TEST_TIMEOUT_MS },
    () => {
      const editors = editorsOf(LARGEST_TESTED_TEAM - 1);
      fc.assert(
        fc.property(
          fc.array(stepArbitrary(LARGEST_TESTED_TEAM), { maxLength: MAX_STEPS }),
          (steps) => {
            playScenario(editors, steps);
          },
        ),
      );
    },
  );
});
