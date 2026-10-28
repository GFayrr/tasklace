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
import type { TaskId } from '../../../core/model/project';
import { createSharedDocument } from '../../../core/shared/shared-document';
import type { SharedSession } from '../../../core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../../core/testing/project-builder';
import { sessionOn } from '../../../core/testing/session-copy';
import { seededRandom } from '../../../core/testing/test-crypto';
import { until } from '../../testing/plan-host';
import { joinThroughRelay, newcomerPlan, type RelayTeamMember } from '../../testing/relay-team';
import { drawnNames } from '../../testing/tcp-relay';
import { writeRelayCertificate } from '../../testing/test-certificate';

vi.mock('node:tls', async (importOriginal) => {
  const tls = await importOriginal<typeof import('node:tls')>();
  const { trustingTestCertificate } = await import('../../testing/test-certificate');
  return { ...tls, getCACertificates: trustingTestCertificate(tls.getCACertificates) };
});

vi.mock('../../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/limits')>()),
  SNAPSHOT_AFTER_BYTES: 1_024,
}));

const ROOM_CHUNKS = 4;
const REFUSED_PLAN_TASKS = 12_000;
const EDITS_AFTER_REFUSAL = 64;
const NAME_DIGITS = 5;
const REFUSAL_TIMEOUT_MS = 120_000;
const ACCESS = drawRelayAccess(seededRandom(89));
const EDIT_KEYS = relayKeysOf(ACCESS);
const VIEW_KEYS = relayKeysOf(viewAccessOf(ACCESS));

let folder: string;
let removeFolder: () => Promise<void>;
let relay: RunningRelay;
const members: RelayTeamMember[] = [];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  relay = await startRelayServer({
    config: testConfig(folder, {
      ...(await writeRelayCertificate(folder)),
      RELAY_MAX_ROOM_BYTES: String(ROOM_CHUNKS * RELAY_CHUNK_BYTES),
    }),
  });
});

afterEach(async () => {
  members.splice(0).forEach((member) => {
    member.leave();
  });
  await relay.close();
  await removeFolder();
});

/** Follows a session through the relay of the test with the link that edits, leaving it after the test. */
function join(session: SharedSession, creates = false): RelayTeamMember {
  const member = joinThroughRelay({ port: relay.port, session, keys: EDIT_KEYS, creates });
  members.push(member);
  return member;
}

describe('a member the relay refuses alone', () => {
  it(
    'leaves the snapshots of the others whole: a newcomer gets the plan they all hold, without the change the relay refused',
    { timeout: REFUSAL_TIMEOUT_MS },
    async () => {
      const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
      const owner = join(sessionOn(origin, 1), true);
      await until(owner.isSettled);
      const other = join(sessionOn(origin, 2));
      const refused = join(sessionOn(origin, 3));
      await until(() => other.isCaughtUp() && refused.isCaughtUp());
      expect(
        refused.session.applyAll(
          drawnNames(REFUSED_PLAN_TASKS).map((name, index) => ({
            type: 'putTask' as const,
            task: { ...workTask(`n${String(index).padStart(NAME_DIGITS, '0')}`), name },
          })),
        ).ok,
      ).toBe(true);
      await until(() => refused.problems.includes('ended TOO_LARGE'));
      const task = other.session.project().tasks.find(({ id }) => id === ('a' as TaskId));
      if (task === undefined) {
        throw new Error('The task of the plan is missing.');
      }
      for (let edit = 1; edit <= EDITS_AFTER_REFUSAL; edit += 1) {
        expect(
          other.session.apply({ type: 'putTask', task: { ...task, name: `Edit ${String(edit)}` } })
            .ok,
        ).toBe(true);
        await until(other.isSettled);
      }
      await until(
        () => owner.session.project().tasks[0]?.name === `Edit ${String(EDITS_AFTER_REFUSAL)}`,
      );
      const expected = other.session.project();
      const newcomer = await newcomerPlan(relay.port, VIEW_KEYS);
      expect([
        newcomer.session.project(),
        owner.session.project(),
        other.snapshotsSent() > 0,
        refused.problems,
        [...owner.problems, ...other.problems, ...newcomer.problems],
        refused.session.project().tasks.length,
      ]).toEqual([expected, expected, true, ['ended TOO_LARGE'], [], REFUSED_PLAN_TASKS + 1]);
    },
  );
});
