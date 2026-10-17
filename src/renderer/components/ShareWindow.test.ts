import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import type { CollaborationSettings } from '../../preload/bridge-contract';
import { openedAppOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, render, single, update } from './testing/render';

const TEXT = english.collaboration;
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens the sample plan with the settings of this computer and renders the application, without opening the share window yet. */
async function renderApp(settings: Partial<CollaborationSettings> = {}) {
  const opened = await openedAppOf(PLAN);
  opened.control.collaboration.settingsResult = {
    ok: true,
    value: { name: null, port: 47_313, firewallNoticeSeen: false, ...settings },
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

/** Renders the application and shares the plan at once, from a computer that gave its name and saw the word about the network. */
async function renderSharing(settings: Partial<CollaborationSettings> = {}) {
  const rendered = await renderApp({ name: 'Camille', firewallNoticeSeen: true, ...settings });
  await clickAndSettle(button(rendered.root, TEXT.share));
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
      ['saveSettings', { name: 'Camille', port: 47_313, firewallNoticeSeen: false }],
      ['saveSettings', { name: 'Camille', port: 47_313, firewallNoticeSeen: true }],
      ['share', 'Thesis', 'Camille'],
    ]);
    expect([textsOf(dialog, '.character').join(''), textsOf(dialog, '.address')]).toEqual([
      'K7Q4MZ',
      ['192.168.1.24 · port 47313'],
    ]);
  });

  it('shares at once once the name is known and the word seen, the host shown as the one who edits', async () => {
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
      value: { code: 'K7Q4MZ', port: 47_314, addresses: [], tokenDigest: 'd'.repeat(64) },
    };
    await clickAndSettle(button(root, TEXT.share));
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
      participantId: 'lea',
      name: 'Léa',
      endpoint: { addresses: [], port: 47_313 },
      tokenDigest: 'd'.repeat(64),
    });
    update();
    const dialog = shareWindow(root);
    expect(textsOf(dialog, '.person')).toEqual([
      'CA Camille You · host Can edit',
      'LÉ Léa Joined at 10:00 AM Read only Can edit',
    ]);
    expect(textsOf(dialog, '.people .hint')).toEqual([
      TEXT.newcomers,
      'If you leave, Léa, who has been here the longest, becomes the host and keeps these choices.',
    ]);
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
  });

  it('keeps the choice shown when the host cannot give a right, as for a guest who just left', async () => {
    const { root, control } = await renderSharing();
    control.collaboration.listener?.({
      kind: 'peerJoined',
      peer: 1,
      participantId: 'lea',
      name: 'Léa',
      endpoint: { addresses: [], port: 47_313 },
      tokenDigest: 'd'.repeat(64),
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
      ['saveSettings', { name: 'Cam', port: 47_313, firewallNoticeSeen: true }],
      ['saveSettings', { name: 'Camille M.', port: 47_313, firewallNoticeSeen: true }],
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
      ['saveSettings', { name: 'Camille', port: 47_400, firewallNoticeSeen: false }],
      ['saveSettings', { name: 'Camille', port: 47_401, firewallNoticeSeen: false }],
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
