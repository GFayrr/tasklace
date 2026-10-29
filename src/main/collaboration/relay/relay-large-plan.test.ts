import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer, type RunningRelay } from '../../../../relay/src/server.ts';
import { testConfig } from '../../../../relay/src/testing/relay-client.ts';
import { temporaryFolder } from '../../../../relay/src/testing/relay-records.ts';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
} from '../../../core/collaboration/relay/relay-keys';
import { RELAY_CHUNK_BYTES } from '../../../core/collaboration/relay/relay-wire';
import { createSharedDocument } from '../../../core/shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../../../core/testing/project-builder';
import { sessionOn } from '../../../core/testing/session-copy';
import { seededRandom } from '../../../core/testing/test-crypto';
import { until } from '../../testing/plan-host';
import { joinThroughRelay, newcomerPlan, type RelayTeamMember } from '../../testing/relay-team';
import { drawnNames, startTcpRelay, type TcpRelay } from '../../testing/tcp-relay';
import { writeRelayCertificate } from '../../testing/test-certificate';

vi.mock('node:tls', async (importOriginal) => {
  const tls = await importOriginal<typeof import('node:tls')>();
  const { trustingTestCertificate } = await import('../../testing/test-certificate');
  return { ...tls, getCACertificates: trustingTestCertificate(tls.getCACertificates) };
});

const LARGE_PLAN_TASKS = 10_000;
const LARGE_TRANSFER_TIMEOUT_MS = 120_000;
const NAME_DIGITS = 5;
const ACCESS = drawRelayAccess(seededRandom(83));
const EDIT_KEYS = relayKeysOf(ACCESS);
const VIEW_KEYS = relayKeysOf(viewAccessOf(ACCESS));

let folder: string;
let removeFolder: () => Promise<void>;
let relay: RunningRelay;
const members: RelayTeamMember[] = [];
const networks: TcpRelay[] = [];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  relay = await startRelayServer({
    config: testConfig(folder, await writeRelayCertificate(folder)),
  });
});

afterEach(async () => {
  members.splice(0).forEach((member) => {
    member.leave();
  });
  for (const network of networks.splice(0)) {
    network.cut();
    await network.close();
  }
  await relay.close();
  await removeFolder();
});

/** Starts a plain TCP relay in front of the relay of the test, which cuts every connection once a given direction carried a mebibyte. */
async function cutAfterOneMebibyte(direction: 'up' | 'down'): Promise<TcpRelay> {
  const network = await startTcpRelay(
    () => relay.port,
    direction === 'up'
      ? { afterClientBytes: RELAY_CHUNK_BYTES }
      : { afterTargetBytes: RELAY_CHUNK_BYTES },
  );
  networks.push(network);
  return network;
}

describe('a plan of several mebibytes shared through a relay', () => {
  it(
    'reaches the relay whole after the connection of its owner broke in the middle of sending it, and reaches a newcomer whole after the connection broke in the middle of receiving it',
    { timeout: LARGE_TRANSFER_TIMEOUT_MS },
    async () => {
      const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
      const session = sessionOn(origin, 1);
      expect(
        session.applyAll(
          drawnNames(LARGE_PLAN_TASKS).map((name, index) => ({
            type: 'putTask' as const,
            task: { ...workTask(`n${String(index).padStart(NAME_DIGITS, '0')}`), name },
          })),
        ).ok,
      ).toBe(true);
      const upload = await cutAfterOneMebibyte('up');
      const owner = joinThroughRelay({
        port: upload.port,
        session,
        keys: EDIT_KEYS,
        creates: true,
      });
      members.push(owner);
      await until(() => owner.problems.includes('reconnecting'));
      const witness = joinThroughRelay({
        port: relay.port,
        session: sessionOn(origin, 2),
        keys: VIEW_KEYS,
        creates: false,
      });
      members.push(witness);
      await until(() => witness.session.project().tasks.length === LARGE_PLAN_TASKS + 1);
      const expected = session.project();
      const download = await cutAfterOneMebibyte('down');
      const newcomer = await newcomerPlan(download.port, VIEW_KEYS);
      expect([
        upload.clientBytes() > 2 * RELAY_CHUNK_BYTES,
        download.targetBytes() > 2 * RELAY_CHUNK_BYTES,
        newcomer.session.project().tasks.length,
        newcomer.session.project(),
        witness.session.project(),
        owner.problems,
        newcomer.problems,
      ]).toEqual([
        true,
        true,
        LARGE_PLAN_TASKS + 1,
        expected,
        expected,
        ['reconnecting'],
        ['reconnecting'],
      ]);
    },
  );
});
