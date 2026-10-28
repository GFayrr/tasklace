import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer, type RunningRelay } from '../../../../relay/src/server.ts';
import { testConfig } from '../../../../relay/src/testing/relay-client.ts';
import { temporaryFolder } from '../../../../relay/src/testing/relay-records.ts';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
} from '../../../core/collaboration/relay/relay-keys';
import type { TaskId } from '../../../core/model/project';
import { createSharedDocument } from '../../../core/shared/shared-document';
import type { SharedSession } from '../../../core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../../core/testing/project-builder';
import { sessionOn } from '../../../core/testing/session-copy';
import { seededRandom } from '../../../core/testing/test-crypto';
import { until } from '../../testing/plan-host';
import { joinThroughRelay, newcomerPlan, type RelayTeamMember } from '../../testing/relay-team';
import { writeRelayCertificate } from '../../testing/test-certificate';

vi.mock('node:tls', async (importOriginal) => {
  const tls = await importOriginal<typeof import('node:tls')>();
  const { trustingTestCertificate } = await import('../../testing/test-certificate');
  return { ...tls, getCACertificates: trustingTestCertificate(tls.getCACertificates) };
});

const LARGEST_TESTED_TEAM = 25;
const TEAM_TIMEOUT_MS = 120_000;
const COMMON_TASK = 'common';
const OWN_TASK_DIGITS = 2;
const ROUNDS = 3;
const ACCESS = drawRelayAccess(seededRandom(81));
const EDIT_KEYS = relayKeysOf(ACCESS);
const VIEW_KEYS = relayKeysOf(viewAccessOf(ACCESS));

let folder: string;
let removeFolder: () => Promise<void>;
let relay: RunningRelay;
const members: RelayTeamMember[] = [];

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
  await relay.close();
  await removeFolder();
});

/** Names the task a member of a given rank renames on its own. */
function ownTaskOf(index: number): string {
  return `t${String(index).padStart(OWN_TASK_DIGITS, '0')}`;
}

/** Renames a task of a session, the session refusing nothing a test plan holds. */
function rename(session: SharedSession, id: string, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`No task ${id}`);
  }
  expect(session.apply({ type: 'putTask', task: { ...task, name } }).ok).toBe(true);
}

/** Follows a session through the relay of the test, leaving it after the test. */
function join(session: SharedSession, keys = EDIT_KEYS, creates = false): RelayTeamMember {
  const member = joinThroughRelay({ port: relay.port, session, keys, creates });
  members.push(member);
  return member;
}

describe('a plan shared through a relay by the largest tested team', () => {
  it(
    'brings every member, all editing at once over real connections, and then a newcomer, to the same plan',
    { timeout: TEAM_TIMEOUT_MS },
    async () => {
      const taskIds = [
        COMMON_TASK,
        ...Array.from({ length: LARGEST_TESTED_TEAM }, (_, index) => ownTaskOf(index)),
      ];
      const origin = createSharedDocument(
        project(taskIds.map((id) => workTask(id))),
        TEST_DOCUMENT_ID,
      );
      const owner = join(sessionOn(origin, 1), EDIT_KEYS, true);
      await until(owner.isCaughtUp);
      const team = Array.from({ length: LARGEST_TESTED_TEAM - 1 }, (_, index) =>
        join(sessionOn(origin, index + 2), index === 0 ? VIEW_KEYS : EDIT_KEYS),
      );
      await until(() => team.every((member) => member.isCaughtUp()));
      const editors = [owner, ...team.slice(1)];
      for (let round = 1; round <= ROUNDS; round += 1) {
        editors.forEach(({ session }, index) => {
          rename(session, ownTaskOf(index), `Round ${String(round)} by ${String(index)}`);
          rename(session, COMMON_TASK, `Common ${String(round)} by ${String(index)}`);
        });
      }
      /** Tells whether a session holds the last change every editor made to its own task. */
      const holdsEveryLastChange = (session: SharedSession): boolean =>
        editors.every(
          (_, index) =>
            session.project().tasks.find((task) => task.id === (ownTaskOf(index) as TaskId))
              ?.name === `Round ${String(ROUNDS)} by ${String(index)}`,
        );
      const everyone = [owner, ...team];
      await until(() =>
        everyone.every(
          ({ session }) =>
            holdsEveryLastChange(session) &&
            session.project().tasks[0]?.name === owner.session.project().tasks[0]?.name,
        ),
      );
      const expected = owner.session.project();
      const newcomer = await newcomerPlan(relay.port, VIEW_KEYS);
      expect([
        everyone.map(({ session }) => session.project()),
        newcomer.session.project(),
        [...everyone.flatMap(({ problems }) => problems), ...newcomer.problems],
      ]).toEqual([Array.from({ length: LARGEST_TESTED_TEAM }, () => expected), expected, []]);
    },
  );
});
