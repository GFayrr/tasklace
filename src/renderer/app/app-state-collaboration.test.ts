import { describe, expect, it, vi } from 'vitest';
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
  endpoint: null,
  tokenDigest: null,
};
const TARGET = { address: '192.168.1.24', port: 47_313, code: 'K7Q4MZ' };

/** Joins the plan in a new application state, the host sending the people in it, this page in read only unless told, then the whole plan. */
async function joinedApp(canEdit = false, fake = fakeAppContext()) {
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
  collaboration.listener?.({
    kind: 'hostMessage',
    message: encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) }),
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
      { kind: 'guest', connection: 'connected' },
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

describe('the windows of a shared plan', () => {
  /** Gives the settings of this computer that the fake main process will read. */
  const withSettings = (
    fake: ReturnType<typeof fakeAppContext>,
    name: string | null,
    firewallNoticeSeen: boolean,
  ): void => {
    fake.control.collaboration.settingsResult = {
      ok: true,
      value: { name, port: 47_313, firewallNoticeSeen },
    };
  };

  it('opens no share window without a project', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    await app.openShare();
    expect([app.collaborationWindow, fake.control.collaboration.requests]).toEqual([null, []]);
  });

  it('opens the share window without sharing until a name is given and the word about the network seen', async () => {
    for (const [name, seen] of [
      [null, true],
      ['Camille', false],
    ] as const) {
      const opened = await openedAppOf(PLAN);
      withSettings(opened, name, seen);
      await opened.app.openShare();
      expect([opened.app.collaborationWindow, opened.app.collaboration.mode]).toEqual([
        'share',
        { kind: 'idle' },
      ]);
      expect(opened.control.collaboration.requests).toEqual([['settings']]);
    }
  });

  it('shares at once from a computer that already gave a name and saw the word about the network, reading the settings once', async () => {
    const opened = await openedAppOf(PLAN);
    withSettings(opened, 'Camille', true);
    await opened.app.openShare();
    expect([opened.app.collaborationWindow, opened.app.collaboration.mode.kind]).toEqual([
      'share',
      'hosting',
    ]);
    opened.app.closeCollaborationWindow();
    await opened.app.openShare();
    expect(opened.control.collaboration.requests).toEqual([
      ['settings'],
      ['share', PLAN.name, 'Camille'],
    ]);
  });

  it('keeps why the plan could not be shared until it is shared', async () => {
    const opened = await openedAppOf(PLAN);
    withSettings(opened, 'Camille', true);
    opened.control.collaboration.shareResult = { ok: false, error: { code: 'NO_FREE_PORT' } };
    await opened.app.openShare();
    expect([opened.app.shareFailure, opened.app.collaboration.mode]).toEqual([
      { code: 'NO_FREE_PORT' },
      { kind: 'idle' },
    ]);
    opened.control.collaboration.shareResult = {
      ok: true,
      value: { code: 'K7Q4MZ', port: 47_313, addresses: [], tokenDigest: 'd'.repeat(64) },
    };
    await opened.app.startSharing();
    expect([opened.app.shareFailure, opened.app.collaboration.mode.kind]).toEqual([
      null,
      'hosting',
    ]);
  });

  it('tells that the settings of this computer could not be read, opening no window', async () => {
    const opened = await openedAppOf(PLAN);
    opened.control.collaboration.settingsResult = { ok: false, error: { code: 'READ_FAILED' } };
    await opened.app.openShare();
    await opened.app.openJoin();
    expect([opened.app.collaborationWindow, noticeTexts(opened.app)]).toEqual([
      null,
      [english.fileErrors.READ_FAILED],
    ]);
  });

  it('looks for plans nearby while the join window is open, and leaves a plan still being joined when it closes', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    withSettings(fake, 'Léa', true);
    await app.openJoin();
    expect(app.collaborationWindow).toBe('join');
    expect(await app.join(TARGET)).toEqual({ ok: true, value: null });
    app.closeCollaborationWindow();
    await settle();
    expect([app.collaborationWindow, app.collaboration.mode]).toEqual([null, { kind: 'idle' }]);
    expect(fake.control.collaboration.requests.map(([name, value]) => [name, value])).toEqual([
      ['settings', undefined],
      ['findPlans', true],
      ['join', { ...TARGET, participantId: 'id1', name: 'Léa' }],
      ['findPlans', false],
      ['stop', undefined],
    ]);
  });

  it('closes the join window once the plan joined opens, no longer looking for plans nearby', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    withSettings(fake, 'Léa', true);
    fake.control.collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
    await app.openJoin();
    await app.join(TARGET);
    fake.control.collaboration.listener?.({ kind: 'connected' });
    fake.control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'update', update: Uint8Array.of(0, 0) }),
    });
    fake.control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) }),
    });
    await settle();
    await settle();
    expect([app.collaborationWindow, app.collaboration.mode]).toEqual([
      null,
      { kind: 'guest', connection: 'connected' },
    ]);
    expect(fake.control.collaboration.requests.at(-1)).toEqual(['findPlans', false]);
  });

  it('closes the share window when another project opens, which stops sharing', async () => {
    const opened = await openedAppOf(PLAN);
    withSettings(opened, 'Camille', true);
    await opened.app.openShare();
    await opened.app.open();
    await settle();
    expect([opened.app.collaborationWindow, opened.app.collaboration.mode]).toEqual([
      null,
      { kind: 'idle' },
    ]);
    expect(opened.control.collaboration.requests.filter(([name]) => name === 'findPlans')).toEqual(
      [],
    );
  });
});

describe('a host that changes', () => {
  it('tells the person who now hosts the plan that the host left', async () => {
    const { app, control } = await joinedApp();
    control.collaboration.listener?.({ kind: 'hostLeft' });
    await settle();
    control.collaboration.listener?.({
      kind: 'becameHost',
      sharing: { code: 'N3WC0D', port: 47_313, addresses: [], tokenDigest: 'd'.repeat(64) },
    });
    expect(noticeTexts(app)).toEqual([
      'Camille left. You now host the plan; the others join you on their own.',
    ]);
  });

  it('tells a guest who hosts the plan now', async () => {
    const { app, control } = await joinedApp();
    control.collaboration.listener?.({ kind: 'hostLeft' });
    await settle();
    const me = app.collaboration.me ?? HOST.id;
    const noah: Participant = { ...HOST, id: requireParticipantId('noah'), name: 'Noah', rank: 2 };
    const lea: Participant = { ...HOST, id: me, name: 'Léa', isHost: false, rank: 1, color: 1 };
    control.collaboration.listener?.({ kind: 'connected' });
    control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'participants', you: me, participants: [noah, lea] }),
    });
    expect(noticeTexts(app)).toEqual(['Camille left. Noah now hosts the plan; you are still in.']);
  });
});

describe('changes made in read only away from the host', () => {
  /** Joins in read only, changes the plan while the connection is lost, then comes back, the host telling what it holds. */
  async function changedAway(fake = fakeAppContext()) {
    const joined = await joinedApp(false, fake);
    const { app, control } = joined;
    control.collaboration.listener?.({ kind: 'reconnecting' });
    expect(app.rename('Mine')).toBe(true);
    control.collaboration.listener?.({ kind: 'connected' });
    control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) }),
    });
    await settle();
    return joined;
  }

  it('tells where the changes are kept once the shared plan shows again, and opens them when asked', async () => {
    const { app, control } = await changedAway();
    control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'update', update: Uint8Array.of(0, 0) }),
    });
    control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'stateVector', vector: Uint8Array.of(0) }),
    });
    await settle();
    await settle();
    expect([
      control.collaboration.requests.filter(([name]) => name === 'keepOwnChanges').length,
      app.keptChanges,
      app.project?.name,
    ]).toEqual([1, { planName: 'Mine', copyName: 'Mine (my changes)' }, PLAN.name]);
    control.collaboration.openKeptResult = openedProjectOf({ ...PLAN, name: 'Mine (my changes)' });
    const opening = app.openKeptChanges();
    await settle();
    app.closePrompt?.answer('discard');
    await opening;
    await settle();
    expect([
      app.keptChanges,
      app.project?.name,
      app.hasFile,
      app.collaboration.mode,
      control.collaboration.requests.at(-1),
    ]).toEqual([null, 'Mine (my changes)', true, { kind: 'idle' }, ['stop']]);
  });

  it('closes the window that tells where the changes are kept', async () => {
    const { app } = await changedAway();
    app.closeKeptChanges();
    expect(app.keptChanges).toBeNull();
  });

  it('warns when the local copy of the changes kept apart could not be written', async () => {
    const fake = fakeAppContext();
    fake.control.collaboration.keepResult = { ok: true, value: { localCopySaved: false } };
    const { app } = await changedAway(fake);
    expect([app.keptChanges, noticeTexts(app)]).toEqual([
      { planName: 'Mine', copyName: 'Mine (my changes)' },
      [english.notices.localCopyFailed],
    ]);
  });

  it('tells, lastingly, that the changes could not be kept apart', async () => {
    const fake = fakeAppContext();
    fake.control.collaboration.keepResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = await changedAway(fake);
    expect([
      app.keptChanges,
      noticeTexts(app),
      app.notices.map((notice) => notice.lasting),
    ]).toEqual([null, [english.collaboration.ownChangesNotKept], [true]]);
    errors.mockRestore();
  });
});
