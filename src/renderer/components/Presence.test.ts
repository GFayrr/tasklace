import { testDigest, testJoinCode } from '../../core/testing/secrets';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { requireParticipantId, type Participant } from '../../core/collaboration/participants';
import { project, testId, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import {
  fakeAppContext,
  openedAppOf,
  openedProjectOf,
  settle,
} from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, render, single, update } from './testing/render';

const TEXT = english.collaboration;
const PLAN = project([workTask('a', { name: 'Survey' }), workTask('b', { name: 'Write' })], [], {
  name: 'Thesis',
});
const HOST: Participant = {
  id: requireParticipantId('camille'),
  name: 'Camille',
  color: 0,
  canEdit: true,
  isHost: true,
  rank: 0,
  selectedTaskId: testId('a'),
  endpoint: null,
  tokenDigest: null,
};
const GUESTS = ['Léa', 'Noah', 'Inès', 'Omar', 'Zoé', 'Yann'];

/** Gives the texts of the elements matching a selector, spaces folded. */
function textsOf(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) =>
    element.textContent.replace(/\s+/g, ' ').trim(),
  );
}

/** Renders a plan this page shares, with guests who joined, the first one on the first task. */
async function renderHosting(guestCount: number) {
  const opened = await openedAppOf(PLAN);
  const { collaboration } = opened.control;
  collaboration.settingsResult = {
    ok: true,
    value: { name: 'Camille', port: 47_313, firewallNoticeSeen: true },
  };
  await opened.app.openShare();
  opened.app.closeCollaborationWindow();
  GUESTS.slice(0, guestCount).forEach((name, index) => {
    collaboration.listener?.({
      kind: 'peerJoined',
      peer: index + 1,
      participantId: requireParticipantId(`guest${String(index)}`),
      name,
      endpoint: { addresses: [], port: 47_313 },
      tokenDigest: testDigest('d'.repeat(64)),
    });
  });
  collaboration.listener?.({
    kind: 'peerMessage',
    peer: 1,
    message: encodeMessage({ kind: 'presence', name: 'Léa', selectedTaskId: testId('a') }),
  });
  const root = render(App, { app: opened.app });
  await settle();
  update();
  return { ...opened, root };
}

/** Renders a plan this page joined, the host on the first task, in read only unless told. */
async function renderJoined(canEdit = false) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  const { collaboration } = fake.control;
  collaboration.settingsResult = {
    ok: true,
    value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true },
  };
  collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
  await app.collaboration.loadSettings();
  await app.join({ address: '192.168.1.24', port: 47_313, code: testJoinCode('K7Q4MZ') });
  const me = app.collaboration.me ?? requireParticipantId('nobody');
  const guest: Participant = {
    ...HOST,
    id: me,
    name: 'Léa',
    canEdit,
    isHost: false,
    rank: 1,
    color: 1,
    selectedTaskId: null,
    endpoint: null,
    tokenDigest: null,
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
  const root = render(App, { app });
  update();
  return { app, root, control: fake.control };
}

describe('where the others are', () => {
  it('marks the row another person is on with a stripe and their initials, never this person', async () => {
    const { root } = await renderHosting(1);
    const rows = [...root.querySelectorAll<HTMLElement>('.rows .row:not(.add-row)')];
    expect(rows.map((row) => row.querySelectorAll('.presence-mark').length)).toEqual([1, 0]);
    expect(textsOf(root, '.presence')).toEqual(['LÉ']);
    expect(single(root, '.presence').getAttribute('title')).toBe('Léa');
    expect(single(root, '.presence-mark').style.backgroundColor).toBe(
      single(root, '.presence').style.backgroundColor,
    );
  });

  it('shows the people in the chip and the status bar, a few faces and how many more', async () => {
    const { root } = await renderHosting(GUESTS.length);
    expect(textsOf(single(root, 'header.toolbar'), '.face')).toEqual(['CA', 'LÉ', 'NO', '+4']);
    expect(textsOf(single(root, '.status-bar'), '.face')).toEqual([
      'CA',
      'LÉ',
      'NO',
      'IN',
      'OM',
      '+2',
    ]);
    expect(textsOf(root, '.names')).toEqual(['Camille (host), Léa, Noah, Inès, Omar, Zoé, Yann']);
    expect(single(root, '.people').getAttribute('aria-label')).toBe(TEXT.peopleLabel);
    expect(root.querySelector('.read-only')).toBeNull();
  });

  it('shows a person in read only that the host can let them edit, and nothing once they can', async () => {
    const readOnly = await renderJoined();
    expect(textsOf(readOnly.root, '.read-only')).toEqual(['Read only Camille can let you edit.']);
    expect(textsOf(readOnly.root, '.names')).toEqual(['Camille (host), Léa']);
    expect(textsOf(readOnly.root, '.presence')).toEqual(['CA']);
    const editing = await renderJoined(true);
    expect(editing.root.querySelector('.read-only')).toBeNull();
  });
});

describe('the chip of the connection', () => {
  it('offers to share when nothing is shared, and reopens the share window while sharing', async () => {
    const { root, app } = await renderHosting(0);
    click(button(root, TEXT.connected));
    await settle();
    expect(app.collaborationWindow).toBe('share');
    app.closeCollaborationWindow();
    await app.collaboration.stop();
    update();
    expect(textsOf(single(root, 'header.toolbar'), '.share')).toEqual([TEXT.share]);
  });

  it('lets a guest leave the plan, naming who shares it', async () => {
    const { root, app, control } = await renderJoined();
    click(button(root, TEXT.connected));
    expect(textsOf(root, '[role="menuitem"]')).toEqual(['Leave the shared plan Shared by Camille']);
    click(single(root, '[role="menuitem"]'));
    await settle();
    update();
    expect([app.collaboration.mode, control.collaboration.requests.at(-1)]).toEqual([
      { kind: 'idle' },
      ['stop'],
    ]);
    expect(textsOf(single(root, 'header.toolbar'), '.share')).toEqual([TEXT.share]);
  });

  it('shows nothing while joining from an open project, then names the host plainly until the people in the plan arrive', async () => {
    const opened = await openedAppOf(PLAN);
    const { collaboration } = opened.control;
    collaboration.settingsResult = {
      ok: true,
      value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true },
    };
    collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
    await opened.app.collaboration.loadSettings();
    const root = render(App, { app: opened.app });
    await opened.app.join({ address: '192.168.1.24', port: 47_313, code: testJoinCode('K7Q4MZ') });
    update();
    expect(
      single(root, 'header.toolbar').querySelector('.share, [aria-haspopup="menu"].trigger'),
    ).toBeNull();
    collaboration.listener?.({ kind: 'connected' });
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
    update();
    click(button(root, TEXT.connected));
    expect(textsOf(root, '[role="menuitem"]')).toEqual([
      'Leave the shared plan Shared by the person who shares it',
    ]);
  });

  it('says that it reconnects, keeping the changes, then that it is offline, with the people hidden', async () => {
    const { root, control } = await renderJoined(true);
    control.collaboration.listener?.({ kind: 'reconnecting' });
    update();
    expect([
      textsOf(root, '.status-bar .badge.reconnecting'),
      root.querySelector('.people'),
    ]).toEqual([[TEXT.reconnectingShort], null]);
    click(button(root, TEXT.reconnecting));
    expect(textsOf(root, '[role="menuitem"]')).toEqual([
      'Leave the shared plan Tasklace keeps trying to reach Camille. Your changes are kept on this computer.',
    ]);
    control.collaboration.listener?.({ kind: 'offline' });
    update();
    expect([
      textsOf(root, '.status-bar .badge.offline'),
      textsOf(single(root, 'header.toolbar'), '.label'),
    ]).toEqual([[TEXT.offlineShort], [TEXT.offline]]);
  });

  it('says to a person in read only who is offline that the changes will be kept in their own copy', async () => {
    const { root, control } = await renderJoined();
    control.collaboration.listener?.({ kind: 'offline' });
    update();
    expect(textsOf(single(root, 'header.toolbar'), '.label')).toEqual([TEXT.offlineKeptApart]);
  });

  it('says when and why the connection to the host is lost, the plan staying open', async () => {
    const { root, app, control } = await renderJoined();
    control.collaboration.listener?.({ kind: 'ended', reason: 'BROKEN' });
    update();
    expect([
      app.project?.name,
      textsOf(root, '.badge.lost'),
      root.querySelector('.people'),
      root.querySelectorAll('header.toolbar .face').length,
    ]).toEqual(['Thesis', [TEXT.connectionLost], null, 0]);
    click(button(root, TEXT.connectionLost));
    expect(textsOf(root, '[role="menuitem"]')).toEqual([
      'Leave the shared plan The connection to Camille broke: what came through it was not what Tasklace expects. The plan stays open on this computer.',
    ]);
  });
});
