import { afterEach, describe, expect, it } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { requireParticipantId } from '../../core/collaboration/participants';
import { createGuest } from '../../core/collaboration/sync';
import type { TaskId } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import type { SharedSession } from '../../core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import { sessionOn } from '../../core/testing/session-copy';
import { systemRandomBytes } from './aes-gcm';
import { connectAsGuest, type GuestClient } from './guest-client';
import type { HostServer } from './host-server';
import type { StartTimer } from './secure-connection';
import { LOOPBACK, messageOf, startPlanHost, until } from '../testing/plan-host';

const LARGEST_TESTED_TEAM = 25;
const TEAM_TIMEOUT_MS = 60_000;
const COMMON_TASK = 'common';
const TOKEN_HEX_DIGITS = 64;
const OWN_TASK_DIGITS = 2;
/** Starts no timer, the test waiting for events instead. */
const noTimer: StartTimer = () => () => undefined;
const servers: HostServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Names the task a guest of a given rank renames on its own. */
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

/** Joins a host as a guest of a given rank with the code, syncing a session of its own and telling when it may edit. */
function joinTeam(port: number, code: string, index: number, session: SharedSession) {
  const participantId = requireParticipantId(`guest-${String(index)}`);
  let canEdit = false;
  let client: GuestClient | null = null;
  const guest = createGuest({
    session,
    send: (message) => {
      expect(client?.send(encodeMessage(message)).ok).toBe(true);
    },
    report: (event) => {
      if (event.kind === 'roster') {
        canEdit =
          event.participants.find((participant) => participant.id === participantId)?.canEdit ===
          true;
      }
    },
  });
  client = connectAsGuest({
    address: LOOPBACK,
    port,
    secret: { kind: 'code', code },
    introduction: {
      participantId,
      name: `Guest ${String(index)}`,
      token: index.toString(16).padStart(TOKEN_HEX_DIGITS, '0'),
      endpoint: { addresses: [], port },
    },
    startTimer: noTimer,
    randomBytes: systemRandomBytes,
    events: {
      opened: () => {
        guest.connected();
      },
      message: (bytes) => {
        guest.receive(messageOf(bytes));
      },
      planKey: () => undefined,
      ended: () => undefined,
    },
  });
  return { canEdit: () => canEdit };
}

describe('a shared plan for the largest tested team', () => {
  it(
    'brings a host and every guest, all editing at once over real connections, to the same plan',
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
      const hostSession = sessionOn(origin, 1);
      const shared = await startPlanHost(hostSession, { planKey: null, letEdit: true });
      servers.push(shared.server);
      const sessions: SharedSession[] = [];
      const members: { canEdit: () => boolean }[] = [];
      for (let index = 0; index < LARGEST_TESTED_TEAM; index += 1) {
        const session = sessionOn(origin, index + 2);
        sessions.push(session);
        const member = joinTeam(shared.server.port, shared.server.code(), index, session);
        members.push(member);
        await until(member.canEdit);
      }
      sessions.forEach((session, index) => {
        rename(session, ownTaskOf(index), `Done by ${String(index)}`);
        rename(session, COMMON_TASK, `Common by ${String(index)}`);
      });
      rename(hostSession, COMMON_TASK, 'Common by the host');
      /** Tells whether a session holds the change every guest made to its own task. */
      const holdsEveryOwnChange = (session: SharedSession): boolean =>
        session
          .project()
          .tasks.filter((task) => task.id !== (COMMON_TASK as TaskId))
          .every((task) => task.name === `Done by ${String(Number(task.id.slice(1)))}`);
      await until(
        () =>
          [hostSession, ...sessions].every(holdsEveryOwnChange) &&
          sessions.every(
            (session) => session.project().tasks[0]?.name === hostSession.project().tasks[0]?.name,
          ),
      );
      const expected = hostSession.project();
      for (const session of sessions) {
        expect(session.project()).toEqual(expected);
      }
      expect(shared.refusals).toEqual([]);
    },
  );
});
