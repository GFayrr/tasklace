import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  requireParticipantId,
  type ParticipantId,
} from '../../src/core/collaboration/participants';
import { openSecureChannel, type SecureChannel } from '../../src/core/collaboration/secure/channel';
import type { SessionKeys } from '../../src/core/collaboration/secure/cpace';
import { createHost, type Host } from '../../src/core/collaboration/sync';
import { MAX_MERGE_REPAIR_ROUNDS, MAX_PARTICIPANTS } from '../../src/core/limits';
import { createSharedDocument, TASKS_ROOT } from '../../src/core/shared/shared-document';
import type { SharedSession } from '../../src/core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../src/core/testing/project-builder';
import { sessionOn } from '../../src/core/testing/session-copy';
import { aesGcm } from '../../src/main/collaboration/aes-gcm';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  batched,
  BATCH_SIZE,
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  MEASURED_RUNS,
  SIZE_FACTOR,
  SMALL_TASK_COUNT,
} from './measure-growth';

const WARM_UP_RUNS = 1;
const EDITS_NEEDED = (MEASURED_RUNS + WARM_UP_RUNS) * BATCH_SIZE;
const HOST = requireParticipantId('host');
const EDITOR = requireParticipantId('editor');
const SMALL_TEAM = Math.floor((MAX_PARTICIPANTS - 1) / SIZE_FACTOR);
const LARGE_TEAM = SMALL_TEAM * SIZE_FACTOR;
const SMALL_MISSING_EDITS = 500;
const KEY_BYTES = 32;
const FORGER_CLIENT_ID = 99;
const LOOPS_BEYOND_THE_BUDGET = MAX_MERGE_REPAIR_ROUNDS + 1;
const FORGED_ID_DIGITS = 6;
const HOST_KEYS: SessionKeys = {
  send: new Uint8Array(KEY_BYTES).fill(1),
  receive: new Uint8Array(KEY_BYTES).fill(2),
  resume: new Uint8Array(KEY_BYTES).fill(3),
};
const GUEST_KEYS: SessionKeys = { ...HOST_KEYS, send: HOST_KEYS.receive, receive: HOST_KEYS.send };

/** Builds a shared document holding the large project with a given number of tasks. */
function sharedProject(taskCount: number): Y.Doc {
  return createSharedDocument(buildLargeProject(LARGE_PROJECT_SEED, taskCount), TEST_DOCUMENT_ID);
}

/** Renames the task at a position of a session's initial project, a typical small edit. */
function taskRenamer(session: SharedSession): (index: number) => void {
  const tasks = session.project().tasks;
  return (index) => {
    const task = tasks[index % tasks.length];
    if (task !== undefined) {
      session.apply({ type: 'putTask', task: { ...task, name: `Edit ${String(index)}` } });
    }
  };
}

/** Records the updates an editor sends while making a number of small edits. */
function recordEdits(document: Y.Doc, count: number): Uint8Array[] {
  const editor = sessionOn(document, 2);
  const updates: Uint8Array[] = [];
  editor.onUpdate((update) => {
    updates.push(update);
  });
  const rename = taskRenamer(editor);
  for (let index = 0; index < count; index += 1) {
    rename(index);
  }
  return updates;
}

/** Starts a host of a document with a number of guests who may edit, the first one being the editor, counting what it sends once they are all in. */
function hostWithTeam(document: Y.Doc, teamSize: number): { host: Host; sent: () => number } {
  let sent = 0;
  const host = createHost({
    session: sessionOn(document, 1),
    roster: null,
    tokenDigest: null,
    hostId: HOST,
    name: 'Camille',
    send: () => {
      sent += 1;
    },
    report: (event) => {
      if (event.kind === 'refused') {
        throw new Error(event.reason);
      }
    },
  });
  const guests: ParticipantId[] = [
    EDITOR,
    ...Array.from({ length: teamSize - 1 }, (_, index) =>
      requireParticipantId(`guest-${String(index)}`),
    ),
  ];
  for (const guest of guests) {
    expect(host.connect(guest, guest, null, null).ok).toBe(true);
    expect(host.setRight(guest, true).ok).toBe(true);
  }
  sent = 0;
  return { host, sent: () => sent };
}

/** Makes the host receive, one by one, the recorded edits of its editor. */
function receiving(host: Host, updates: readonly Uint8Array[]): () => void {
  return batched(BATCH_SIZE, (index) => {
    host.receive(EDITOR, { kind: 'update', update: updates[index] ?? new Uint8Array() });
  });
}

/** Builds a forged update adding tasks that form more loops of summaries than there are rounds of repair, each loop needing one. */
function forgedLoops(origin: Y.Doc, taskCount: number): Uint8Array {
  const malicious = new Y.Doc();
  malicious.clientID = FORGER_CLIENT_ID;
  Y.applyUpdate(malicious, Y.encodeStateAsUpdate(origin));
  const loopLength = Math.floor(taskCount / LOOPS_BEYOND_THE_BUDGET);
  /** Names the task at a position of a loop. */
  const idOf = (position: number): string => `c${String(position).padStart(FORGED_ID_DIGITS, '0')}`;
  malicious.transact(() => {
    for (let position = 0; position < taskCount; position += 1) {
      const loopStart = position - (position % loopLength);
      const next = loopStart + ((position + 1 - loopStart) % loopLength);
      const entry = new Y.Map<unknown>();
      malicious.getMap(TASKS_ROOT).set(idOf(position), entry);
      Object.entries({ ...workTask('c'), kind: 'summary', parentId: idOf(next) })
        .filter(([key]) => key !== 'id')
        .forEach(([key, value]) => {
          entry.set(key, value);
        });
    }
  });
  return Y.encodeStateAsUpdate(malicious, Y.encodeStateVector(origin));
}

describe('growth of the host of a shared plan', () => {
  const smallDocument = sharedProject(SMALL_TASK_COUNT);
  const largeDocument = sharedProject(LARGE_TASK_COUNT);

  it('merges and passes on an edit of a guest in a time that does not depend on the size of the plan', () => {
    const small = hostWithTeam(smallDocument, SMALL_TEAM);
    const large = hostWithTeam(largeDocument, SMALL_TEAM);
    const ratio = growthRatio(
      receiving(small.host, recordEdits(smallDocument, EDITS_NEEDED)),
      receiving(large.host, recordEdits(largeDocument, EDITS_NEEDED)),
    );
    console.info(`Edit of a guest at the host: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
    expect([small.sent(), large.sent()]).toEqual([
      EDITS_NEEDED * SMALL_TEAM,
      EDITS_NEEDED * SMALL_TEAM,
    ]);
  });

  it('passes on an edit in a time at most linear in the number of guests', () => {
    const updates = recordEdits(smallDocument, EDITS_NEEDED);
    const small = hostWithTeam(smallDocument, SMALL_TEAM);
    const large = hostWithTeam(smallDocument, LARGE_TEAM);
    const ratio = growthRatio(receiving(small.host, updates), receiving(large.host, updates));
    console.info(`Edit passed on to ${String(LARGE_TEAM)} guests: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
    expect(large.sent()).toBe(EDITS_NEEDED * LARGE_TEAM);
  });

  it('sends a guest who comes back what it missed in a time linear in what it missed', () => {
    /** Prepares a host holding a number of edits a returning guest missed, and the state vector of that guest. */
    const catchingUp = (missedEdits: number) => {
      const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
      const vector = Y.encodeStateVector(origin);
      const { host } = hostWithTeam(origin, 1);
      recordEdits(origin, missedEdits).forEach((update) => {
        host.receive(EDITOR, { kind: 'update', update });
      });
      return () => {
        host.receive(EDITOR, { kind: 'stateVector', vector });
      };
    };
    const ratio = growthRatio(
      catchingUp(SMALL_MISSING_EDITS),
      catchingUp(SMALL_MISSING_EDITS * SIZE_FACTOR),
    );
    console.info(`Catching up: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('refuses a forged update that uses up the repair budget in a time linear in its size', () => {
    /** Prepares a host and an update whose loops of tasks use up every round of repair. */
    const refusing = (taskCount: number) => {
      const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
      const session = sessionOn(origin, 1);
      const update = forgedLoops(origin, taskCount);
      return () => {
        expect(session.merge(update)).toEqual({
          ok: false,
          error: { kind: 'invalidProject', issues: [{ path: '', code: 'TOO_MANY_REPAIRS' }] },
        });
      };
    };
    const ratio = growthRatio(refusing(SMALL_TASK_COUNT), refusing(LARGE_TASK_COUNT));
    console.info(`Forged update using up the repairs: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});

describe('growth of the encrypted channel', () => {
  it('seals and opens a plan in a time linear in its size', () => {
    /** Prepares the two ends of a channel and the state of a plan carried from one to the other. */
    const carrying = (taskCount: number) => {
      const state = Y.encodeStateAsUpdate(sharedProject(taskCount));
      let host: SecureChannel = openSecureChannel(HOST_KEYS, aesGcm, zlibCompressor);
      let guest: SecureChannel = openSecureChannel(GUEST_KEYS, aesGcm, zlibCompressor);
      return () => {
        host = openSecureChannel(HOST_KEYS, aesGcm, zlibCompressor);
        guest = openSecureChannel(GUEST_KEYS, aesGcm, zlibCompressor);
        const sealed = host.seal(state, 'plan');
        if (!sealed.ok) {
          throw new Error(sealed.error);
        }
        const opened = sealed.value.map((frame) => guest.open(frame));
        expect(opened.at(-1)?.ok).toBe(true);
      };
    };
    const ratio = growthRatio(carrying(SMALL_TASK_COUNT), carrying(LARGE_TASK_COUNT));
    console.info(`Channel: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
