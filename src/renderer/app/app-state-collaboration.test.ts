import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { requireParticipantId, type Participant } from '../../core/collaboration/participants';
import { project, testId, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedAppOf, openedProjectOf, settle } from './testing/fake-app-context';

const PLAN = project([workTask('a', { name: 'Write' }), workTask('b')]);
const HOST: Participant = {
  id: requireParticipantId('camille'),
  name: 'Camille',
  color: 0,
  canEdit: true,
  isHost: true,
  rank: 0,
  selectedTaskId: null,
};
const TARGET = { address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ' };

/** Joins the plan in a new application state, the host sending the people in it, this page in read only unless told, then the whole plan. */
async function joinedApp(canEdit = false) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  const { collaboration } = fake.control;
  collaboration.settingsResult = {
    ok: true,
    value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true },
  };
  collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
  await app.collaboration.loadSettings();
  expect(await app.join(TARGET)).toEqual({ ok: true, value: null });
  const me = app.collaboration.me;
  if (me === null) {
    throw new Error('The page did not join');
  }
  const guest: Participant = {
    ...HOST,
    id: me,
    name: 'Léa',
    canEdit,
    isHost: false,
    rank: 1,
    color: 1,
  };
  collaboration.listener?.({ kind: 'connected' });
  collaboration.listener?.({
    kind: 'hostMessage',
    message: encodeMessage({ kind: 'participants', you: me, participants: [HOST, guest] }),
  });
  collaboration.listener?.({
    kind: 'hostMessage',
    message: encodeMessage({ kind: 'update', update: Uint8Array.of(0, 0) }),
  });
  await settle();
  await settle();
  return { app, ...fake };
}

/** Returns the texts of the messages shown. */
function noticeTexts(app: AppState): string[] {
  return app.notices.map((notice) => notice.text);
}

describe('a plan joined in read only', () => {
  it('opens the plan the host sent, checked by the main process, without file', async () => {
    const { app, control } = await joinedApp();
    expect(control.collaboration.requests.find(([name]) => name === 'openShared')).toEqual([
      'openShared',
      Uint8Array.of(0, 0),
    ]);
    expect([app.project?.name, app.hasFile, app.collaboration.mode]).toEqual([
      PLAN.name,
      false,
      { kind: 'guest', connected: true },
    ]);
  });

  it('refuses every change, naming the host who can let this person edit', async () => {
    const { app } = await joinedApp();
    const refusal = 'You are in read only. Camille can let you edit.';
    expect(app.rename('Mine')).toBe(false);
    expect(app.tryEdit(() => ({ ok: true, value: [] }))).toBe(refusal);
    app.undo();
    app.redo();
    expect(noticeTexts(app)).toEqual([refusal]);
    expect(app.project?.name).toBe(PLAN.name);
  });

  it('lets this person edit once the host allows it', async () => {
    const { app } = await joinedApp(true);
    expect(app.rename('Ours')).toBe(true);
    expect(noticeTexts(app)).toEqual([]);
  });

  it('says only that the plan is in read only when the host is not known', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf(PLAN);
    await app.open();
    fake.control.collaboration.settingsResult = {
      ok: true,
      value: { name: 'Léa', port: 1, firewallNoticeSeen: true },
    };
    await app.collaboration.loadSettings();
    await app.join(TARGET);
    expect(app.rename('Mine')).toBe(false);
    expect(noticeTexts(app)).toEqual([english.collaboration.readOnlyWithoutHost]);
  });
});

describe('joining from the application', () => {
  it('asks first about a changed project without file, joining nothing when the user cancels', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    await app.newProject();
    expect(app.rename('Changed')).toBe(true);
    await settle();
    const joining = app.join(TARGET);
    await settle();
    expect(app.closePrompt?.reason).toBe('unsaved');
    app.closePrompt?.answer('cancel');
    expect(await joining).toBeNull();
    expect(fake.control.collaboration.requests).toEqual([]);
  });

  it('tells the others the task selected while sharing, and stops sharing when another project opens', async () => {
    const { app, control } = await openedAppOf(PLAN);
    control.collaboration.settingsResult = {
      ok: true,
      value: { name: 'Camille', port: 47_313, firewallNoticeSeen: true },
    };
    await app.collaboration.loadSettings();
    expect((await app.collaboration.share()).ok).toBe(true);
    app.select(testId('b'));
    await settle();
    expect(app.collaboration.participants.map((participant) => participant.selectedTaskId)).toEqual(
      ['b'],
    );
    await app.open();
    await settle();
    expect([app.collaboration.mode, control.collaboration.requests.at(-1)]).toEqual([
      { kind: 'idle' },
      ['stop'],
    ]);
  });
});
