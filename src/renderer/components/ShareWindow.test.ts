import { testShownLink } from '../../core/testing/secrets';
import { encodeMessage } from '../../core/collaboration/messages';
import { requireParticipantId } from '../../core/collaboration/participants';
import { testDigest, testJoinCode } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import type { CollaborationSettings } from '../../preload/bridge-contract';
import {
  openedAppOf,
  openedProjectOf,
  relayRequests,
  settle,
} from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, render, single, update } from './testing/render';

const TEXT = english.collaboration;
const RELAY = english.relay;
const SHOWN = {
  edit: testShownLink('tasklace://relay.example.org/#e1.Hq7Lm2…'),
  view: testShownLink('tasklace://relay.example.org/#v1.P0dX8w…'),
};
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens the sample plan with the settings of this computer and renders the application, without opening the share window yet. */
async function renderApp(settings: Partial<CollaborationSettings> = {}) {
  const opened = await openedAppOf(PLAN);
  opened.control.collaboration.settingsResult = {
    ok: true,
    value: { name: null, port: 47_313, firewallNoticeSeen: false, relayAddress: null, ...settings },
  };
  const root = render(App, { app: opened.app });
  return { ...opened, root };
}

/** Clicks an element and waits for what it started. */
async function clickAndSettle(element: HTMLElement): Promise<void> {
  click(element);
  await settle();
  update();
}

/** Types a value in a field as a person does, then leaves it. */
async function typeIn(root: ParentNode, selector: string, value: string): Promise<void> {
  const field = single(root, selector);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`${selector} is not a field`);
  }
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  update();
}

/** Gives the share window, failing the test when it is not open. */
function shareWindow(root: ParentNode): HTMLDialogElement {
  const dialog = single(root, 'dialog.share');
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) {
    throw new Error('The share window is not open');
  }
  return dialog;
}

/** Gives the texts of the elements matching a selector. */
function textsOf(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) =>
    element.textContent.replace(/\s+/g, ' ').trim(),
  );
}

/** Renders the application and shares the plan on this network, from a computer that gave its name and saw the word about the network. */
async function renderSharing(settings: Partial<CollaborationSettings> = {}) {
  const rendered = await renderApp({ name: 'Camille', firewallNoticeSeen: true, ...settings });
  await clickAndSettle(button(rendered.root, TEXT.share));
  await clickAndSettle(button(shareWindow(rendered.root), TEXT.startSharing));
  return rendered;
}

describe('sharing the open plan', () => {
  it('asks the name the first time, then tells once about the network before sharing', async () => {
    const { root, app, control } = await renderApp();
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    expect([
      single(dialog, 'h2').textContent,
      single(dialog, '.intro').textContent,
      (single(dialog, '#share-name') as HTMLInputElement).value,
    ]).toEqual(['Share “Thesis”', TEXT.setupIntro, '']);
    await clickAndSettle(button(dialog, TEXT.startSharing));
    expect(textsOf(dialog, '.field .message')).toEqual([TEXT.noName]);
    await typeIn(dialog, '#share-name', '  Camille ');
    await clickAndSettle(button(dialog, TEXT.startSharing));
    expect(textsOf(root, '.confirm h3')).toEqual([TEXT.firewallTitle]);
    expect(textsOf(root, '.confirm p')).toEqual([TEXT.firewallBody]);
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="firewall-title"]'), TEXT.cancel),
    );
    expect([textsOf(root, '.confirm h3'), app.collaboration.mode]).toEqual([[], { kind: 'idle' }]);
    await clickAndSettle(button(dialog, TEXT.startSharing));
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="firewall-title"]'), TEXT.continue),
    );
    expect(control.collaboration.requests).toEqual([
      ['settings'],
      [
        'saveSettings',
        { name: 'Camille', port: 47_313, firewallNoticeSeen: false, relayAddress: null },
      ],
      [
        'saveSettings',
        { name: 'Camille', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
      ],
      ['share', 'Thesis', 'Camille'],
    ]);
    expect([textsOf(dialog, '.character').join(''), textsOf(dialog, '.address')]).toEqual([
      'K7Q4MZ',
      ['192.168.1.24 · port 47313'],
    ]);
  });

  it('shares on this network without asking again once the name is known and the word seen, the host shown as the one who edits', async () => {
    const { root, app } = await renderSharing();
    const dialog = shareWindow(root);
    expect([app.collaboration.mode.kind, textsOf(dialog, '.person')]).toEqual([
      'hosting',
      ['CA Camille You · host Can edit'],
    ]);
    expect(button(root, TEXT.connected).textContent.replace(/\s+/g, ' ').trim()).toBe(
      `${TEXT.shared} CA`,
    );
  });

  it('logs a word about the network it could not keep as seen, and shares all the same', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { root, app, control } = await renderApp({ name: 'Camille' });
    await clickAndSettle(button(root, TEXT.share));
    control.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await clickAndSettle(button(shareWindow(root), TEXT.startSharing));
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="firewall-title"]'), TEXT.continue),
    );
    expect([app.collaboration.mode.kind, errors.mock.calls]).toEqual([
      'hosting',
      [['The word about the network could not be kept as seen:', { code: 'WRITE_FAILED' }]],
    ]);
  });

  it('tells why the plan could not be shared', async () => {
    const { root, control } = await renderApp({ name: 'Camille', firewallNoticeSeen: true });
    control.collaboration.shareResult = { ok: false, error: { code: 'NO_FREE_PORT' } };
    await clickAndSettle(button(root, TEXT.share));
    await clickAndSettle(button(shareWindow(root), TEXT.startSharing));
    expect(textsOf(shareWindow(root), '[role="alert"]')).toEqual([english.fileErrors.NO_FREE_PORT]);
  });

  it('copies the code, saying when it could not', async () => {
    const { root, control } = await renderSharing();
    const dialog = shareWindow(root);
    await clickAndSettle(button(dialog, TEXT.copy));
    expect(button(dialog, TEXT.copied).textContent.trim()).toBe(TEXT.copied);
    control.collaboration.copyResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, TEXT.copied));
    expect(textsOf(dialog, '.code-part .message')).toEqual([TEXT.copyFailed]);
  });

  it('tells the port taken by another program, and that this computer is on no private network', async () => {
    const { root, control } = await renderApp({ name: 'Camille', firewallNoticeSeen: true });
    control.collaboration.shareResult = {
      ok: true,
      value: {
        code: testJoinCode('K7Q4MZ'),
        port: 47_314,
        addresses: [],
        tokenDigest: testDigest('d'.repeat(64)),
      },
    };
    await clickAndSettle(button(root, TEXT.share));
    await clickAndSettle(button(shareWindow(root), TEXT.startSharing));
    expect(textsOf(shareWindow(root), '.code-part .message, .code-part .hint')).toEqual([
      TEXT.codeHint,
      TEXT.noAddress,
      'Port 47313 is in use by another program, so Tasklace shares on 47314.',
    ]);
  });

  it('lists who joined and when, and lets the host give each guest the right to edit', async () => {
    const { root, app, control } = await renderSharing();
    control.collaboration.listener?.({
      kind: 'peerJoined',
      peer: 1,
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      endpoint: { addresses: [], port: 47_313 },
      tokenDigest: testDigest('d'.repeat(64)),
    });
    update();
    const dialog = shareWindow(root);
    expect(textsOf(dialog, '.person')).toEqual([
      'CA Camille You · host Can edit',
      'LÉ Léa Joined at 10:00 AM Read only Can edit',
    ]);
    expect(textsOf(dialog, '.people .hint')).toEqual([TEXT.newcomers]);
    expect(single(dialog, '[role="radiogroup"]').getAttribute('aria-label')).toBe(
      'What Léa may do',
    );
    const canEdit = dialog.querySelectorAll<HTMLInputElement>('.segment input')[1];
    if (canEdit === undefined) {
      throw new Error('No “Can edit” choice');
    }
    canEdit.checked = true;
    canEdit.dispatchEvent(new Event('change', { bubbles: true }));
    update();
    expect(app.collaboration.participants.map((participant) => participant.canEdit)).toEqual([
      true,
      true,
    ]);
    expect(textsOf(dialog, '.segment.chosen')).toEqual([TEXT.canEdit]);
    expect(textsOf(dialog, '.people .hint')).toEqual([
      TEXT.newcomers,
      'If you leave, Léa, who has been here the longest, becomes the host and keeps these choices.',
    ]);
  });

  it('keeps the choice shown when the host cannot give a right, as for a guest who just left', async () => {
    const { root, control } = await renderSharing();
    control.collaboration.listener?.({
      kind: 'peerJoined',
      peer: 1,
      participantId: requireParticipantId('lea'),
      name: 'Léa',
      endpoint: { addresses: [], port: 47_313 },
      tokenDigest: testDigest('d'.repeat(64)),
    });
    update();
    const dialog = shareWindow(root);
    const canEdit = dialog.querySelectorAll<HTMLInputElement>('.segment input')[1];
    if (canEdit === undefined) {
      throw new Error('No “Can edit” choice');
    }
    control.collaboration.listener?.({ kind: 'peerLeft', peer: 1 });
    canEdit.checked = true;
    canEdit.dispatchEvent(new Event('change', { bubbles: true }));
    expect(canEdit.checked).toBe(false);
  });

  it('changes the name while sharing, refusing an empty one and telling one it could not keep', async () => {
    const { root, app, control } = await renderSharing();
    const dialog = shareWindow(root);
    await typeIn(dialog, '#share-name', 'Cam');
    expect(app.collaboration.participants.map((participant) => participant.name)).toEqual(['Cam']);
    await typeIn(dialog, '#share-name', 'Cam');
    await typeIn(dialog, '#share-name', ' ');
    expect(textsOf(dialog, '.field .message')).toEqual([TEXT.noName]);
    control.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await typeIn(dialog, '#share-name', 'Camille M.');
    expect(textsOf(dialog, '.field .message')).toEqual([TEXT.nameNotKept]);
    expect(control.collaboration.requests.filter(([name]) => name === 'saveSettings')).toEqual([
      ['saveSettings', { name: 'Cam', port: 47_313, firewallNoticeSeen: true, relayAddress: null }],
      [
        'saveSettings',
        { name: 'Camille M.', port: 47_313, firewallNoticeSeen: true, relayAddress: null },
      ],
    ]);
  });

  it('keeps the port for the next time, refusing a number that is not a port and telling one it could not keep', async () => {
    const { root, control } = await renderApp({ name: 'Camille' });
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    expect(textsOf(dialog, '.network small')).toEqual([
      'Used the next time you share. The default is 47313.',
    ]);
    await typeIn(dialog, '#share-port', '0');
    expect(textsOf(dialog, '.network .message')).toEqual(['Type a port from 1 to 65535.']);
    await typeIn(dialog, '#share-port', '');
    expect(textsOf(dialog, '.network .message')).toEqual(['Type a port from 1 to 65535.']);
    await typeIn(dialog, '#share-port', '47400');
    expect(textsOf(dialog, '.network .message')).toEqual([]);
    control.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await typeIn(dialog, '#share-port', '47401');
    expect(textsOf(dialog, '.network .message')).toEqual([TEXT.portNotKept]);
    expect(control.collaboration.requests.filter(([name]) => name === 'saveSettings')).toEqual([
      [
        'saveSettings',
        { name: 'Camille', port: 47_400, firewallNoticeSeen: false, relayAddress: null },
      ],
      [
        'saveSettings',
        { name: 'Camille', port: 47_401, firewallNoticeSeen: false, relayAddress: null },
      ],
    ]);
  });

  it('stops sharing, or closes the window and keeps sharing', async () => {
    const { root, app, control } = await renderSharing();
    await clickAndSettle(button(shareWindow(root), TEXT.done));
    expect([app.collaborationWindow, app.collaboration.mode.kind]).toEqual([null, 'hosting']);
    await clickAndSettle(button(root, TEXT.connected));
    await clickAndSettle(button(shareWindow(root), TEXT.stopSharing));
    expect([app.collaborationWindow, app.collaboration.mode.kind]).toEqual([null, 'idle']);
    expect(control.collaboration.requests.at(-1)).toEqual(['stop']);
  });

  it('closes with the close button, the Cancel button and the Escape key', async () => {
    const { root, app } = await renderApp({ name: 'Camille' });
    for (const close of [
      () => {
        click(button(shareWindow(root), TEXT.close));
      },
      () => {
        click(button(shareWindow(root), TEXT.cancel));
      },
      () => {
        shareWindow(root).dispatchEvent(new Event('cancel', { cancelable: true }));
        update();
      },
    ]) {
      await clickAndSettle(button(root, TEXT.share));
      close();
      expect([app.collaborationWindow, single(root, 'dialog.share').hasAttribute('open')]).toEqual([
        null,
        false,
      ]);
    }
  });
});

/** Chooses where to share in the share window, as a person clicks one of the two ways. */
function chooseWay(dialog: ParentNode, title: string): void {
  const way = [...dialog.querySelectorAll('.choice')].find(
    (choice) => choice.querySelector('.choice-title')?.textContent.trim() === title,
  );
  const input = way?.querySelector('input');
  if (input === null || input === undefined) {
    throw new Error(`No way to share named ${title}`);
  }
  click(input);
}

/** Renders the application with a relay kept on this computer and shares the plan through it from the share window. */
async function renderRelaySharing(kept = true) {
  const rendered = await renderApp({
    name: 'Camille',
    firewallNoticeSeen: true,
    relayAddress: 'wss://relay.example.org',
  });
  rendered.control.collaboration.relay.shareResult = {
    ok: true,
    value: { shown: SHOWN, relay: 'relay.example.org', kept },
  };
  await clickAndSettle(button(rendered.root, TEXT.share));
  await clickAndSettle(button(shareWindow(rendered.root), TEXT.startSharing));
  return rendered;
}

describe('sharing the open plan through a relay', () => {
  it('first asks where the others are, on this network when no relay is kept, with the guide for a relay', async () => {
    const { root, control } = await renderApp({ name: 'Camille', firewallNoticeSeen: true });
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    const onNetwork = [
      textsOf(dialog, '.choice'),
      textsOf(dialog, '.choice.chosen .choice-title'),
      textsOf(dialog, '.intro'),
      dialog.querySelectorAll('details.network').length,
    ];
    chooseWay(dialog, RELAY.throughRelay);
    const address = single(dialog, '#share-relay-address') as HTMLInputElement;
    expect([
      onNetwork,
      textsOf(dialog, '.choice.chosen .choice-title'),
      address.value,
      address.placeholder,
      textsOf(dialog, '.hint'),
      dialog.querySelectorAll('details.network').length,
      control.collaboration.requests,
    ]).toEqual([
      [
        [
          `${RELAY.onThisNetwork} ${RELAY.onThisNetworkHint}`,
          `${RELAY.throughRelay} ${RELAY.throughRelayHint}`,
        ],
        [RELAY.onThisNetwork],
        [TEXT.setupIntro],
        1,
      ],
      [RELAY.throughRelay],
      '',
      RELAY.addressPlaceholder,
      [RELAY.noRelay, RELAY.encrypted],
      0,
      [['settings']],
    ]);
  });

  it('opens on the relay kept on this computer, its address typed already', async () => {
    const { root } = await renderApp({ name: 'Camille', relayAddress: 'wss://relay.example.org' });
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    expect([
      textsOf(dialog, '.choice.chosen .choice-title'),
      (single(dialog, '#share-relay-address') as HTMLInputElement).value,
      textsOf(dialog, '.hint'),
    ]).toEqual([[RELAY.throughRelay], 'wss://relay.example.org', [RELAY.encrypted]]);
  });

  it('opens the guide, telling when the browser could not', async () => {
    const { root, control } = await renderApp({ name: 'Camille' });
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    chooseWay(dialog, RELAY.throughRelay);
    await clickAndSettle(button(dialog, RELAY.openGuide));
    const opened = textsOf(dialog, '.no-relay .message');
    control.collaboration.relay.guideResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, RELAY.openGuide));
    expect([opened, textsOf(dialog, '.no-relay .message'), relayRequests(control)]).toEqual([
      [],
      [RELAY.guideNotOpened],
      [['openGuide'], ['openGuide']],
    ]);
  });

  it('asks for the address of the relay before sharing, and tells why the relay could not be reached', async () => {
    const { root, control } = await renderApp({ name: 'Camille' });
    await clickAndSettle(button(root, TEXT.share));
    const dialog = shareWindow(root);
    chooseWay(dialog, RELAY.throughRelay);
    await clickAndSettle(button(dialog, TEXT.startSharing));
    const empty = textsOf(dialog, '.field .message');
    control.collaboration.relay.shareResult = {
      ok: false,
      error: { code: 'RELAY_ENDED', reason: 'UNREACHABLE' },
    };
    await typeIn(dialog, '#share-relay-address', 'wss://Relay.example.org:8443/');
    await clickAndSettle(button(dialog, TEXT.startSharing));
    const unreachable = textsOf(dialog, '[role="alert"]');
    chooseWay(dialog, RELAY.onThisNetwork);
    expect([empty, unreachable, textsOf(dialog, '[role="alert"]'), relayRequests(control)]).toEqual(
      [
        [RELAY.noAddress],
        [
          'The relay relay.example.org:8443 did not answer. Check your connection, or ask who sent you the link.',
        ],
        [],
        [['shareThroughRelay', 'wss://Relay.example.org:8443/']],
      ],
    );
  });

  it('shows both links once shared, copies each through the main process and lists this person as one who edits', async () => {
    const { root, control } = await renderRelaySharing();
    const dialog = shareWindow(root);
    const shown = [
      textsOf(dialog, '.link-part h3'),
      textsOf(dialog, '.link'),
      textsOf(dialog, '.link-part .hint'),
      textsOf(dialog, '.people .person'),
      textsOf(dialog, '.people .hint'),
      textsOf(dialog, '.foot button'),
    ];
    await clickAndSettle(button(dialog, RELAY.copyEditLink));
    const copiedEdit = button(dialog, RELAY.copyEditLink).textContent.trim();
    control.collaboration.relay.copyLinkResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, RELAY.copyViewLink));
    expect([shown, copiedEdit, textsOf(dialog, '.links .message'), relayRequests(control)]).toEqual(
      [
        [
          [RELAY.editLink, RELAY.viewLink],
          [SHOWN.edit, SHOWN.view],
          [RELAY.editLinkHint, RELAY.viewLinkHint],
          ['CA Camille · you Can edit'],
          [RELAY.rightsHint],
          [TEXT.leave, TEXT.done],
        ],
        TEXT.copied,
        [RELAY.copyFailed],
        [
          ['shareThroughRelay', 'wss://relay.example.org'],
          ['copyRelayLink', 'edit'],
          ['copyRelayLink', 'view'],
        ],
      ],
    );
  });

  it('tells when this computer cannot keep the link', async () => {
    const { root } = await renderRelaySharing(false);
    expect(textsOf(shareWindow(root), '.links .message.warning')).toEqual([RELAY.linkNotKept]);
  });

  it('lists the others with what their link lets them do', async () => {
    const { root, control } = await renderRelaySharing();
    const listener = control.collaboration.listener;
    listener?.({ kind: 'relayConnected', member: 1, members: [2] });
    listener?.({ kind: 'relayCaughtUp' });
    listener?.({
      kind: 'relayPresence',
      member: 2,
      presence: {
        bytes: encodeMessage({ kind: 'presence', name: 'Léa', selectedTaskId: null }),
        canEdit: false,
      },
    });
    await settle();
    update();
    expect(textsOf(shareWindow(root), '.people .person')).toEqual([
      'CA Camille · you Can edit',
      `LÉ Léa ${TEXT.readOnlyRight}`,
    ]);
  });

  it('makes new links once confirmed, telling that they are ready or why they could not be made', async () => {
    const { root, control } = await renderRelaySharing();
    const dialog = shareWindow(root);
    await clickAndSettle(button(dialog, RELAY.makeNewLinks));
    const asked = textsOf(root, '.confirm h3');
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="new-links-title"]'), TEXT.cancel),
    );
    const cancelled = relayRequests(control).length;
    const fresh = {
      edit: testShownLink('tasklace://relay.example.org/#e1.Zk3Rt9…'),
      view: SHOWN.view,
    };
    control.collaboration.relay.newLinksResult = {
      ok: true,
      value: { shown: fresh, relay: 'relay.example.org', kept: true },
    };
    await clickAndSettle(button(dialog, RELAY.makeNewLinks));
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="new-links-title"]'), RELAY.makeNewLinks),
    );
    const made = [textsOf(dialog, '.link'), textsOf(dialog, '[role="status"]')];
    control.collaboration.relay.newLinksResult = { ok: false, error: { code: 'NOT_CONNECTED' } };
    await clickAndSettle(button(dialog, RELAY.makeNewLinks));
    await clickAndSettle(
      button(single(root, '.confirm[aria-labelledby="new-links-title"]'), RELAY.makeNewLinks),
    );
    expect([
      asked,
      cancelled,
      made,
      textsOf(dialog, '[role="alert"]'),
      relayRequests(control),
    ]).toEqual([
      [RELAY.newLinksTitle],
      1,
      [[fresh.edit, fresh.view], [RELAY.newLinksMade]],
      [english.fileErrors.NOT_CONNECTED],
      [['shareThroughRelay', 'wss://relay.example.org'], ['makeNewLinks'], ['makeNewLinks']],
    ]);
  });

  it('offers to forget a plan the relay no longer finds in place of new links, telling when it could not', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { root, app, control } = await renderRelaySharing();
    const listener = control.collaboration.listener;
    listener?.({ kind: 'relayConnected', member: 1, members: [] });
    listener?.({ kind: 'relayCaughtUp' });
    listener?.({ kind: 'relayEnded', reason: 'NO_ROOM' });
    await settle();
    update();
    const dialog = shareWindow(root);
    const shown = [
      textsOf(dialog, '.gone .hint'),
      dialog.querySelectorAll('details.new-links').length,
    ];
    control.collaboration.relay.forgetResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, RELAY.forgetPlan));
    const refused = textsOf(dialog, '.gone [role="alert"]');
    control.collaboration.relay.forgetResult = { ok: true, value: null };
    await clickAndSettle(button(dialog, RELAY.forgetPlan));
    expect([
      shown,
      refused,
      app.collaboration.relay.isActive,
      relayRequests(control).slice(-2),
      error.mock.calls,
    ]).toEqual([
      [[RELAY.notOnRelay], 0],
      [RELAY.notForgotten],
      false,
      [['forgetSharedPlan'], ['forgetSharedPlan']],
      [['The shared plan could not be forgotten:', { code: 'TASK_FAILED' }]],
    ]);
  });

  it('leaves the plan shared through a relay', async () => {
    const { root, app, control } = await renderRelaySharing();
    await clickAndSettle(button(shareWindow(root), TEXT.leave));
    expect([
      app.collaborationWindow,
      app.collaboration.relay.isActive,
      control.collaboration.requests.at(-1),
    ]).toEqual([null, false, ['stop']]);
  });
});

describe('the share window of a plan joined with the link that reads', () => {
  it('shows only the link that reads, this person in read only and no way to make new links', async () => {
    const { root, app, control } = await renderApp({ name: 'Léa' });
    const offered = openedProjectOf(PLAN, { fileName: '' });
    if (!offered.ok) {
      throw new Error('The plan could not be offered.');
    }
    control.collaboration.relay.joinResult = {
      ok: true,
      value: {
        project: offered.value,
        shown: { edit: null, view: SHOWN.view },
        relay: 'relay.example.org',
        bytesSinceSnapshot: 0,
        kept: true,
      },
    };
    await app.joinByLink('tasklace://relay.example.org/#v1.key');
    await settle();
    await clickAndSettle(button(root, RELAY.readOnly));
    const dialog = shareWindow(root);
    expect([
      textsOf(dialog, '.link-part h3'),
      textsOf(dialog, '.people .person'),
      dialog.querySelectorAll('details.new-links').length,
    ]).toEqual([[RELAY.viewLink], [`LÉ Léa · you ${TEXT.readOnlyRight}`], 0]);
  });
});
