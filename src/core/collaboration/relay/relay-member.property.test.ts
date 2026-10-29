import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createSharedDocument } from '../../shared/shared-document';
import type { SharedSession } from '../../shared/shared-session';
import { CONVERGENCE_TEST_TIMEOUT_MS } from '../../testing/arbitraries';
import { project, TEST_DOCUMENT_ID, workTask } from '../../testing/project-builder';
import { sessionOn } from '../../testing/session-copy';
import { plainCompression, seededRandom, testAead } from '../../testing/test-crypto';
import { encodeMessage } from '../messages';
import {
  createRelayAssembler,
  sealRelayMessage,
  type RelayAssembler,
  type RelayCrypto,
} from './relay-envelope';
import {
  drawRelayAccess,
  isSignedBy,
  relayKeysOf,
  viewAccessOf,
  type RelayKeys,
} from './relay-keys';
import { createRelayMember, type RelayMember } from './relay-member';
import { readRelayRecord, signedRecordBytes } from './relay-wire';

vi.mock('../../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits')>()),
  SNAPSHOT_AFTER_BYTES: 256,
}));

const TASK_IDS = ['a', 'b', 'c'];
const FORGED_MARK = 'F';
const MIN_STEPS = 30;
const MAX_STEPS = 90;
const MAX_MARK = 99;
const MAX_DRAIN_DELIVERIES = 100_000;
const FEW_EDITORS = 3;
const LARGEST_TESTED_TEAM = 25;

type Step =
  | { readonly kind: 'edit'; readonly who: number; readonly task: number; readonly mark: number }
  | { readonly kind: 'deliver' | 'drop' | 'reconnect' | 'repeat' | 'swap'; readonly who: number }
  | { readonly kind: 'forge' };

type Frame =
  | { readonly type: 'record'; readonly seq: number; readonly record: Uint8Array }
  | { readonly type: 'caughtUp' };

interface Stored {
  readonly seq: number;
  readonly record: Uint8Array;
  readonly message: string;
}

interface Client {
  readonly keys: RelayKeys;
  readonly session: SharedSession;
  readonly member: RelayMember;
  readonly assembler: RelayAssembler;
  readonly inbox: Frame[];
  connected: boolean;
  lastSeq: number;
}

/** Builds the steps of a scenario for a number of members, the last one only viewing the plan. */
function stepArbitrary(memberCount: number): fc.Arbitrary<Step> {
  const who = fc.nat({ max: memberCount - 1 });
  return fc.oneof(
    fc.record({
      kind: fc.constant('edit' as const),
      who,
      task: fc.nat({ max: TASK_IDS.length - 1 }),
      mark: fc.nat({ max: MAX_MARK }),
    }),
    fc.record({ kind: fc.constantFrom('deliver', 'drop', 'reconnect', 'repeat', 'swap'), who }),
    fc.constant({ kind: 'forge' as const }),
  );
}

/** Renames a task of a session to a name marking who changed it. */
function rename(session: SharedSession, index: number, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === TASK_IDS[index]);
  if (task !== undefined) {
    session.apply({ type: 'putTask', task: { ...task, name } });
  }
}

/** Runs a relay that keeps the records of one room, refuses those not signed for it, passes each one to every member in, and drops what a whole snapshot covers, as the real relay does, while letting a test make it misbehave. */
function createSimulatedRelay(keys: RelayKeys) {
  let stored: Stored[] = [];
  let nextSeq = 0;
  const clients: Client[] = [];
  /** Drops the messages whose chunks kept all came at or before the sequence a snapshot covers, whole or given up by the members. */
  const compact = (covers: number): void => {
    const byMessage = Map.groupBy(stored, (entry) => entry.message);
    const covered = new Set(
      [...byMessage]
        .filter(([, entries]) => entries.every((entry) => entry.seq <= covers))
        .map(([message]) => message),
    );
    stored = stored.filter((entry) => !covered.has(entry.message));
  };
  /** Keeps a record under the next sequence and passes it to every member in, whether or not it is signed. */
  const keep = (record: Uint8Array): void => {
    const read = readRelayRecord(record);
    if (read === null) {
      return;
    }
    nextSeq += 1;
    const message = `${bytesToHex(read.messageId)}.${bytesToHex(read.salt)}`;
    stored.push({ seq: nextSeq, record, message });
    for (const client of clients.filter((candidate) => candidate.connected)) {
      client.inbox.push({ type: 'record', seq: nextSeq, record });
    }
    const chunks = stored.filter((entry) => entry.message === message);
    if (read.kind === 'snapshot' && chunks.length === read.count) {
      compact(read.covers);
    }
  };
  return {
    clients,
    append: (record: Uint8Array): void => {
      const read = readRelayRecord(record);
      if (
        read !== null &&
        isSignedBy(keys.verifyKey, signedRecordBytes(keys.roomId, record), read.signature)
      ) {
        keep(record);
      }
    },
    keepUnchecked: keep,
    connect: (client: Client): void => {
      client.connected = true;
      client.inbox.length = 0;
      for (const entry of stored.filter((candidate) => candidate.seq > client.lastSeq)) {
        client.inbox.push({ type: 'record', seq: entry.seq, record: entry.record });
      }
      client.inbox.push({ type: 'caughtUp' });
    },
  };
}

/** Plays members editing through a relay that loses connections, repeats, reorders and lets a forged record through, then checks that every member and a newcomer hold the same plan, without the forged change. */
function playScenario(editorCount: number, steps: readonly Step[]): void {
  const origin = createSharedDocument(
    project(TASK_IDS.map((id) => workTask(id))),
    TEST_DOCUMENT_ID,
  );
  const access = drawRelayAccess(seededRandom(1));
  const editKeys = relayKeysOf(access);
  const viewKeys = relayKeysOf(viewAccessOf(access));
  const relay = createSimulatedRelay(editKeys);
  /** Opens a member with its keys on a copy of the plan, sealing what it sends straight to the relay while it is in. */
  const startClient = (keys: RelayKeys, clientId: number): Client => {
    const session = sessionOn(origin, clientId);
    const crypto: RelayCrypto = {
      aead: testAead,
      compression: plainCompression,
      randomBytes: seededRandom(clientId),
    };
    const client: Client = {
      keys,
      session,
      assembler: createRelayAssembler(keys, crypto),
      inbox: [],
      connected: false,
      lastSeq: 0,
      member: createRelayMember({
        session,
        canEdit: keys.sign !== null,
        bytesSinceSnapshot: 0,
        randomBytes: seededRandom(clientId + 1_000),
        send: (outgoing) => {
          if (!client.connected || outgoing.kind !== 'message') {
            return;
          }
          const sealed = sealRelayMessage(
            keys,
            { ...outgoing.message, seen: client.lastSeq },
            crypto,
          );
          if (sealed.ok) {
            sealed.value.forEach(relay.append);
          }
        },
        report: () => undefined,
      }),
    };
    relay.clients.push(client);
    return client;
  };
  const members = [
    ...Array.from({ length: editorCount }, (_unused, index) => startClient(editKeys, index + 1)),
    startClient(viewKeys, editorCount + 1),
  ];
  /** Hands the next frame waiting for a member to it, as its main process does: skipping a sequence it already had and counting a record as had only once it joined its message. */
  const deliver = (client: Client): void => {
    const frame = client.inbox.shift();
    if (frame?.type === 'caughtUp') {
      client.member.caughtUp();
      return;
    }
    if (frame === undefined) {
      return;
    }
    if (frame.seq <= client.lastSeq) {
      return;
    }
    const opened = client.assembler.take(frame.seq, frame.record);
    if (!opened.ok) {
      return;
    }
    client.lastSeq = frame.seq;
    if (opened.value !== null) {
      client.member.receive({ ...opened.value, settled: client.assembler.settled() });
    }
  };
  /** Brings every member in and delivers until nothing waits. */
  const settleAll = (): void => {
    relay.clients.filter((client) => !client.connected).forEach(relay.connect);
    for (let count = 0; relay.clients.some((client) => client.inbox.length > 0); count += 1) {
      if (count > MAX_DRAIN_DELIVERIES) {
        throw new Error('The relay never became quiet.');
      }
      relay.clients.forEach(deliver);
    }
  };
  /** Lets the relay pass a change signed with a key that is not the key of the plan, as a member in read only or the relay itself could forge. */
  const forge = (): void => {
    const forger = sessionOn(origin, 999);
    rename(forger, 0, `${FORGED_MARK}1`);
    const forgedKeys = relayKeysOf(drawRelayAccess(seededRandom(77)));
    const records = sealRelayMessage(
      { ...forgedKeys, roomId: editKeys.roomId, encryptionKey: editKeys.encryptionKey },
      {
        kind: 'update',
        messageId: new Uint8Array(16).fill(7),
        covers: 0,
        seen: 0,
        bytes: encodeMessage({ kind: 'update', update: forger.encodeState() }),
      },
      { aead: testAead, compression: plainCompression, randomBytes: seededRandom(78) },
    );
    if (records.ok) {
      records.value.forEach(relay.keepUnchecked);
    }
  };
  /** Plays one step. */
  const play = (step: Step): void => {
    if (step.kind === 'forge') {
      forge();
      return;
    }
    const client = members[step.who % members.length];
    if (client === undefined) {
      return;
    }
    switch (step.kind) {
      case 'edit':
        if (client.keys.sign !== null) {
          rename(client.session, step.task, `${String(step.who)}.${String(step.mark)}`);
        }
        return;
      case 'deliver':
        deliver(client);
        return;
      case 'drop':
        client.connected = false;
        client.inbox.length = 0;
        client.member.disconnected();
        return;
      case 'reconnect':
        if (!client.connected) {
          relay.connect(client);
        }
        return;
      case 'repeat': {
        const [head] = client.inbox;
        if (head !== undefined) {
          client.inbox.push(head);
        }
        return;
      }
      case 'swap': {
        const [one, two] = client.inbox.splice(0, 2);
        client.inbox.unshift(...[two, one].filter((frame) => frame !== undefined));
      }
    }
  };
  members.forEach(relay.connect);
  steps.forEach(play);
  settleAll();
  settleAll();
  const newcomer = startClient(viewKeys, editorCount + 2);
  settleAll();
  const plans = [...members, newcomer].map((client) => client.session.project());
  const names = plans.flatMap((plan) => plan.tasks.map((task) => task.name));
  expect(plans.every((plan) => JSON.stringify(plan) === JSON.stringify(plans[0]))).toBe(true);
  expect(names.some((name) => name.startsWith(FORGED_MARK))).toBe(false);
}

describe('a plan shared through a relay', () => {
  it(
    'ends with the same plan for every member and a newcomer, whatever connections are lost, records repeated or reordered and forged records the relay lets through',
    { timeout: CONVERGENCE_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.array(stepArbitrary(FEW_EDITORS + 1), { minLength: MIN_STEPS, maxLength: MAX_STEPS }),
          (steps) => {
            playScenario(FEW_EDITORS, steps);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'ends with the same plan for a team of the largest tested size',
    { timeout: CONVERGENCE_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.array(stepArbitrary(LARGEST_TESTED_TEAM), {
            minLength: MIN_STEPS,
            maxLength: MAX_STEPS,
          }),
          (steps) => {
            playScenario(LARGEST_TESTED_TEAM - 1, steps);
          },
        ),
        { numRuns: 20 },
      );
    },
  );
});
