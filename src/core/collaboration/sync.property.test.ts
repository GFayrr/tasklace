import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSharedDocument } from '../shared/shared-document';
import type { SharedSession } from '../shared/shared-session';
import { CONVERGENCE_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { sessionOn } from '../testing/session-copy';
import type { CollaborationMessage } from './messages';
import { requireParticipantId, type ParticipantId } from './participants';
import { createGuest, createHost, type Guest } from './sync';

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
  | { readonly kind: 'reconnect'; readonly guest: number }
  | { readonly kind: 'forge' };

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
    fc.record({ kind: fc.constant('reconnect' as const), guest: fc.nat({ max: guestCount - 1 }) }),
    fc.constant({ kind: 'forge' as const }),
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

/** Plays a scenario between a host, guests who may edit and one guest in read only, then checks that every editor ends with the plan of the host and that no change of the reader got in. */
function playScenario(editors: readonly ParticipantId[], steps: readonly Step[]): void {
  const origin = createSharedDocument(
    project(TASK_IDS.map((id) => workTask(id))),
    TEST_DOCUMENT_ID,
  );
  const queue: Packet[] = [];
  const hostSession = sessionOn(origin, 1);
  const host = createHost({
    session: hostSession,
    roster: null,
    tokenDigest: null,
    hostId: HOST,
    name: 'Camille',
    send: ({ to, message }) => queue.push({ toHost: false, to, message }),
    report: () => undefined,
  });
  const ids = [...editors, READER];
  const maxDeliveries = PACKETS_PER_GUEST_AND_STEP * ids.length * (MAX_STEPS + 1);
  const guests = new Map<ParticipantId, { guest: Guest; session: SharedSession }>();
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
  ids.forEach((id, index) => {
    expect(host.connect(id, `Guest ${String(index)}`, null, null).ok).toBe(true);
    guests.get(id)?.guest.connected();
  });
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
  /** Runs one step of the scenario. */
  const run = (step: Step): void => {
    if (step.kind === 'edit') {
      edit(step);
    } else if (step.kind === 'forge') {
      forge();
    } else if (step.kind === 'reconnect') {
      const entry = guests.get(ids[step.guest] ?? READER);
      entry?.guest.disconnected();
      entry?.guest.connected();
    } else {
      handle(step);
    }
  };
  steps.forEach(run);
  drain();
  ids.forEach((id) => {
    guests.get(id)?.guest.disconnected();
    guests.get(id)?.guest.connected();
  });
  drain();
  const expected = hostSession.project();
  for (const id of editors) {
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
