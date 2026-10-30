import { testShownLink } from '../../core/testing/secrets';
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
    value: { name: 'Camille', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
  };
  await opened.app.openShare();
  await opened.app.startSharing();
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
    value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
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
      value: { name: 'Léa', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
    };
    collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
    await opened.app.collaboration.loadSettings();
    const root = render(App, { app: opened.app });
    await opened.app.join({ address: '192.168.1.24', port: 47_313, code: testJoinCode('K7Q4MZ') });
    update();
    expect(
      single(root, 'header.toolbar').querySelector(
        '.share, [aria-haspopup="menu"].trigger:not([aria-label="Tasklace"])',
      ),
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
    ]).toEqual([[TEXT.offlineShort], [TEXT.offlineShort]]);
  });

  it('says to a person in read only who is offline that the changes will be kept in their own copy', async () => {
    const { root, control } = await renderJoined();
    control.collaboration.listener?.({ kind: 'offline' });
    update();
    const label = textsOf(single(root, 'header.toolbar'), '.label');
    click(button(root, TEXT.offlineKeptApart));
    expect([label, textsOf(root, '[role="menuitem"]')]).toEqual([
      [TEXT.offlineReadOnlyShort],
      [`${TEXT.leave} ${TEXT.offlineKeptApart}`],
    ]);
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

/** Renders a plan this page shares through a relay with the link that edits, or joined with the link that reads, Léa being on the first task. */
async function renderRelay(canEdit: boolean) {
  const fake = fakeAppContext();
  const { collaboration } = fake.control;
  collaboration.settingsResult = {
    ok: true,
    value: { name: 'Camille', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
  };
  const app = new AppState(fake.context);
  const root = render(App, { app });
  const shown = {
    edit: canEdit ? testShownLink('tasklace://relay.example.org/#e1.Hq7Lm2…') : null,
    view: testShownLink('tasklace://relay.example.org/#v1.P0dX8w…'),
  };
  const offered = openedProjectOf(PLAN, { fileName: '' });
  if (!offered.ok) {
    throw new Error('The plan could not be offered.');
  }
  collaboration.relay.joinResult = {
    ok: true,
    value: {
      project: offered.value,
      shown,
      relay: 'relay.example.org',
      bytesSinceSnapshot: 0,
      kept: true,
    },
  };
  await app.collaboration.loadSettings();
  await app.joinByLink('tasklace://relay.example.org/#e1.key');
  await settle();
  collaboration.listener?.({ kind: 'relayConnected', member: 1, members: [2] });
  collaboration.listener?.({ kind: 'relayCaughtUp' });
  collaboration.listener?.({
    kind: 'relayPresence',
    member: 2,
    presence: {
      bytes: encodeMessage({ kind: 'presence', name: 'Léa', selectedTaskId: testId('a') }),
      canEdit: true,
    },
  });
  await settle();
  update();
  return { app, root, control: fake.control };
}

describe('a plan shared through a relay', () => {
  const RELAY = english.relay;

  it('shows the people of the relay in the chip, the status bar and the rows they are on', async () => {
    const { root } = await renderRelay(true);
    expect([
      single(root, 'header.toolbar button.host').getAttribute('aria-label'),
      single(root, 'header.toolbar button.host').getAttribute('title'),
      textsOf(single(root, 'header.toolbar'), '.label'),
      textsOf(single(root, 'header.toolbar'), '.face'),
      textsOf(root, '.names'),
      textsOf(root, '.presence'),
      root.querySelector('.read-only'),
    ]).toEqual([RELAY.shared, null, [RELAY.shared], ['CA', 'LÉ'], ['Camille, Léa'], ['LÉ'], null]);
  });

  it('says that it reconnects to the relay, then that it is out of reach, the people hidden', async () => {
    const { root, control } = await renderRelay(true);
    control.collaboration.listener?.({ kind: 'reconnecting' });
    update();
    /** Gives the chip of the connection to the relay as it is now. */
    const chip = () => single(root, 'header.toolbar button.host');
    const reconnecting = [
      textsOf(single(root, 'header.toolbar'), '.label'),
      chip().getAttribute('title'),
      textsOf(root, '.status-bar .badge.reconnecting'),
      textsOf(root, '.presence'),
    ];
    control.collaboration.listener?.({ kind: 'offline' });
    update();
    expect([
      reconnecting,
      textsOf(single(root, 'header.toolbar'), '.label'),
      chip().getAttribute('title'),
      textsOf(root, '.status-bar .badge.offline'),
      root.querySelector('.people'),
    ]).toEqual([
      [[TEXT.reconnectingShort], RELAY.reconnecting, [TEXT.reconnectingShort], []],
      [TEXT.offlineShort],
      RELAY.offline,
      [TEXT.offlineShort],
      null,
    ]);
  });

  it('says to a person with the link that reads that they are in read only, also offline', async () => {
    const { root, control } = await renderRelay(false);
    const connected = [
      textsOf(single(root, 'header.toolbar'), '.label'),
      single(root, 'header.toolbar button.host').getAttribute('title'),
      textsOf(root, '.read-only'),
    ];
    control.collaboration.listener?.({ kind: 'offline' });
    update();
    expect([
      connected,
      textsOf(single(root, 'header.toolbar'), '.label'),
      single(root, 'header.toolbar button.host').getAttribute('title'),
    ]).toEqual([
      [[RELAY.readOnly], RELAY.readOnlyHint, [TEXT.readOnlyRight]],
      [TEXT.offlineReadOnlyShort],
      RELAY.readOnlyHint,
    ]);
  });

  it('tells why the relay ended the plan in a message that stays, and on the chip, the plan staying open', async () => {
    const { root, app, control } = await renderRelay(true);
    control.collaboration.listener?.({ kind: 'relayEnded', reason: 'TOO_LARGE' });
    await settle();
    update();
    expect([
      textsOf(single(root, 'header.toolbar'), '.label'),
      single(root, 'header.toolbar button.host').getAttribute('title'),
      app.notices.map((notice) => [notice.text, notice.lasting]),
      app.project?.name,
    ]).toEqual([
      [TEXT.connectionLost],
      RELAY.ends.TOO_LARGE,
      [[RELAY.ends.TOO_LARGE, true]],
      PLAN.name,
    ]);
  });
});
