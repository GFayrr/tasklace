import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayAssembler,
  openRelayPresence,
  sealRelayMessage,
  sealRelayPresence,
  type RelayCrypto,
} from '../../src/core/collaboration/relay/relay-envelope';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
  type RelayKeys,
} from '../../src/core/collaboration/relay/relay-keys';
import {
  createRelayMember,
  type RelayMember,
  type RelayMemberEvent,
} from '../../src/core/collaboration/relay/relay-member';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import type { SharedSession } from '../../src/core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../src/core/testing/project-builder';
import { sessionOn } from '../../src/core/testing/session-copy';
import { plainCompression, seededRandom, testAead } from '../../src/core/testing/test-crypto';
import { readRoomFile } from './room-file.ts';
import { startRelayServer, type RunningRelay } from './server.ts';
import { WebSocket } from 'ws';
import {
  encodeClientFrame,
  readRelayFrame,
  type ClientFrame,
} from '../../src/core/collaboration/relay/relay-wire';
import { createFrame, testConfig } from './testing/relay-client.ts';
import { temporaryFolder } from './testing/relay-records.ts';

vi.mock('../../src/core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/limits')>()),
  SNAPSHOT_AFTER_BYTES: 512,
}));

const TASK_IDS = ['a', 'b', 'c'];
const ROUNDS = 12;
const ORIGIN = createSharedDocument(project(TASK_IDS.map((id) => workTask(id))), TEST_DOCUMENT_ID);
const ACCESS = drawRelayAccess(seededRandom(31));
const EDIT_KEYS = relayKeysOf(ACCESS);
const VIEW_KEYS = relayKeysOf(viewAccessOf(ACCESS));

interface Person {
  readonly session: SharedSession;
  readonly member: RelayMember;
  readonly socket: WebSocket;
  readonly events: RelayMemberEvent[];
}

let folder: string;
let removeFolder: () => Promise<void>;
let relay: RunningRelay;

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  relay = await startRelayServer({ config: testConfig(folder) });
});

afterEach(async () => {
  await relay.close();
  await removeFolder();
});

/** Connects a person with a link to the plan through the relay, as its main process will: sealing what its member sends and handing it what the relay passes on. */
async function join(keys: RelayKeys, clientId: number, creates: boolean): Promise<Person> {
  const session = sessionOn(ORIGIN, clientId);
  const crypto: RelayCrypto = {
    aead: testAead,
    compression: plainCompression,
    randomBytes: seededRandom(clientId),
  };
  const assembler = createRelayAssembler(keys, crypto);
  let number = 0;
  let since = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${String(relay.port)}/`);
  await new Promise((resolve) => socket.once('open', resolve));
  /** Sends a frame to the relay. */
  const send = (frame: ClientFrame): void => {
    socket.send(encodeClientFrame(frame));
  };
  const events: RelayMemberEvent[] = [];
  const member = createRelayMember({
    session,
    canEdit: keys.sign !== null,
    bytesSinceSnapshot: 0,
    randomBytes: seededRandom(clientId + 100),
    send: (outgoing) => {
      if (outgoing.kind === 'presence') {
        const sealed = sealRelayPresence(keys, number, outgoing.bytes, crypto);
        if (sealed.ok) {
          send({ type: 'presence', bytes: sealed.value });
        }
        return;
      }
      const sealed = sealRelayMessage(keys, { ...outgoing.message, seen: since }, crypto);
      if (sealed.ok) {
        sealed.value.forEach((record) => {
          send({ type: 'append', record });
        });
      }
    },
    report: (event) => events.push(event),
  });
  socket.on('message', (data: Buffer) => {
    const frame = readRelayFrame(new Uint8Array(data));
    if (frame === null || frame === 'UNSUPPORTED_VERSION') {
      throw new Error('The relay sent what is not a frame.');
    }
    if (frame.type === 'welcome') {
      number = frame.member;
    }
    if (frame.type === 'caughtUp') {
      member.caughtUp();
    }
    if (frame.type === 'presence') {
      const opened = openRelayPresence(keys, frame.member, frame.bytes, crypto);
      if (opened !== null) {
        member.presence(frame.member, opened);
      }
    }
    if (frame.type === 'record') {
      const taken = assembler.take(frame.seq, frame.record);
      since = taken.ok ? frame.seq : since;
      if (taken.ok && taken.value !== null) {
        member.receive({ ...taken.value, settled: assembler.settled() });
      }
    }
  });
  send(creates ? createFrame(keys) : { type: 'hello', roomId: keys.roomId, since: 0 });
  return { session, member, socket, events };
}

/** Renames a task of a session. */
function rename(session: SharedSession, index: number, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === TASK_IDS[index]);
  if (task !== undefined) {
    session.apply({ type: 'putTask', task: { ...task, name } });
  }
}

/** Gives the plan each person holds. */
function plansOf(people: readonly Person[]): string[] {
  return people.map((person) => JSON.stringify(person.session.project()));
}

describe('members sharing a plan through the relay', () => {
  it('end with the same plan, a newcomer included, once snapshots shrank what the relay keeps', async () => {
    const first = await join(EDIT_KEYS, 1, true);
    await vi.waitFor(() => {
      expect(first.events).toEqual([]);
    });
    const second = await join(EDIT_KEYS, 2, false);
    const viewer = await join(VIEW_KEYS, 3, false);
    for (let round = 0; round < ROUNDS; round += 1) {
      rename(first.session, round % TASK_IDS.length, `First ${String(round)} ${'x'.repeat(64)}`);
      rename(
        second.session,
        (round + 1) % TASK_IDS.length,
        `Second ${String(round)} ${'y'.repeat(64)}`,
      );
      first.member.setPresence('First', null);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    await vi.waitFor(
      () => {
        expect(new Set(plansOf([first, second, viewer])).size).toBe(1);
      },
      { timeout: 5_000 },
    );
    const newcomer = await join(VIEW_KEYS, 4, false);
    await vi.waitFor(
      () => {
        expect(plansOf([newcomer])).toEqual(plansOf([first]));
      },
      { timeout: 5_000 },
    );
    await relay.close();
    relay = await startRelayServer({ config: testConfig(folder) });
    const stored = readRoomFile(
      new Uint8Array(
        await readFile(path.join(folder, `${Buffer.from(EDIT_KEYS.roomId).toString('hex')}.room`)),
      ),
    );
    expect([
      (stored?.entries[0]?.seq ?? 0) > 1,
      second.events.filter((event) => event.kind === 'people').at(-1),
    ]).toEqual([
      true,
      {
        kind: 'people',
        people: new Map([[1, { name: 'First', selectedTaskId: null, canEdit: true }]]),
      },
    ]);
  });
});
