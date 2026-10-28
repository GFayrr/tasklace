import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { temporaryFolder } from '../../relay/src/testing/relay-records.ts';
import { encodeMessage } from '../../src/core/collaboration/messages';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
} from '../../src/core/collaboration/relay/relay-keys';
import { MESSAGE_ID_BYTES } from '../../src/core/collaboration/relay/relay-wire';
import { MAX_TASKS } from '../../src/core/limits';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { seededRandom } from '../../src/core/testing/test-crypto';
import { startRelaySession } from '../../src/main/collaboration/relay/relay-connection';
import { LOOPBACK, until } from '../../src/main/testing/plan-host';
import { newcomerPlan, realTimer, RELAY_TEST_CRYPTO } from '../../src/main/testing/relay-team';
import { drawnNames } from '../../src/main/testing/tcp-relay';
import { writeRelayCertificate } from '../../src/main/testing/test-certificate';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';

vi.mock('node:tls', async (importOriginal) => {
  const tls = await importOriginal<typeof import('node:tls')>();
  const { trustingTestCertificate } = await import('../../src/main/testing/test-certificate');
  return { ...tls, getCACertificates: trustingTestCertificate(tls.getCACertificates) };
});

const TARGET_MILLISECONDS = 60_000;
const BENCH_TIMEOUT_MS = 600_000;
const RELAY_MAIN = join(import.meta.dirname, '..', '..', 'relay', 'src', 'main.ts');
const RELAY_STARTED = /port (\d+)\./;
const ACCESS = drawRelayAccess(seededRandom(97));

/** Gives the whole state of the largest legitimate plan: as many tasks as a plan may hold, named with the greatest length from letters that hardly compress. */
function largestPlanState(): Uint8Array {
  const large = buildLargeProject(LARGE_PROJECT_SEED, MAX_TASKS);
  const names = drawnNames(MAX_TASKS);
  const plan = {
    ...large,
    tasks: large.tasks.map((task, index) => ({ ...task, name: names[index] ?? task.name })),
  };
  return Y.encodeStateAsUpdate(createSharedDocument(plan, TEST_DOCUMENT_ID));
}

/** Runs the relay of the repository as its own Node process over TLS, as a school runs it, and gives its port and a way to stop it. */
async function startRelayProcess(folder: string) {
  const child = spawn(process.execPath, [RELAY_MAIN], {
    env: {
      PATH: process.env['PATH'] ?? '',
      RELAY_PORT: '0',
      RELAY_DATA_DIR: folder,
      ...(await writeRelayCertificate(folder)),
    },
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const found = RELAY_STARTED.exec(output);
      if (found?.[1] !== undefined) {
        resolve(Number(found[1]));
      }
    });
    child.on('exit', () => {
      reject(new Error(`The relay stopped before listening: ${output}`));
    });
  });
  return { port, stop: () => child.kill() };
}

/** Shares a state through a relay as the main process of its owner does: creates the room, seals the whole plan into one message and waits until the relay passed it back. */
async function shareState(port: number, state: Uint8Array): Promise<() => void> {
  const messageId = seededRandom(98)(MESSAGE_ID_BYTES);
  let caughtUp = false;
  let settled = false;
  const connection = startRelaySession({
    address: { host: LOOPBACK, port, path: '/' },
    keys: relayKeysOf(ACCESS),
    creates: true,
    keepTrying: false,
    crypto: RELAY_TEST_CRYPTO,
    startTimer: realTimer,
    tell: (event) => {
      if (event.kind === 'caughtUp') {
        caughtUp = true;
      }
      if (event.kind === 'delivery') {
        settled = Buffer.from(event.delivery.messageId).equals(Buffer.from(messageId));
      }
    },
  });
  await until(() => caughtUp);
  const sent = connection.send({
    kind: 'message',
    message: {
      kind: 'update',
      messageId,
      covers: 0,
      bytes: encodeMessage({ kind: 'update', update: state }),
    },
  });
  expect(sent.ok).toBe(true);
  await until(() => settled);
  return () => {
    connection.close();
  };
}

describe('relay performance (the largest legitimate plan)', () => {
  it(
    `shares a plan of ${String(MAX_TASKS)} tasks with names of the greatest length through a relay until a newcomer opens it, in less than ${String(TARGET_MILLISECONDS)} ms`,
    { timeout: BENCH_TIMEOUT_MS },
    async () => {
      const state = largestPlanState();
      const { folder, remove } = await temporaryFolder();
      const relay = await startRelayProcess(folder);
      try {
        const start = performance.now();
        const leave = await shareState(relay.port, state);
        const newcomer = await newcomerPlan(relay.port, relayKeysOf(viewAccessOf(ACCESS)));
        const duration = performance.now() - start;
        leave();
        console.info(
          `Sharing ${String(MAX_TASKS)} tasks (${(state.length / 1_048_576).toFixed(0)} MiB) through a relay: ${duration.toFixed(0)} ms`,
        );
        expect([newcomer.session.project().tasks.length, newcomer.problems]).toEqual([
          MAX_TASKS,
          [],
        ]);
        expect(duration).toBeLessThan(TARGET_MILLISECONDS);
      } finally {
        relay.stop();
        await remove();
      }
    },
  );
});
