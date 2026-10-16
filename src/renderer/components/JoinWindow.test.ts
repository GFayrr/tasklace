import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../../core/collaboration/messages';
import { project, workTask } from '../../core/testing/project-builder';
import type { CollaborationSettings, NearbyPlan } from '../../preload/bridge-contract';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, render, single, update } from './testing/render';

const TEXT = english.collaboration;
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });
const NEARBY: NearbyPlan = {
  key: 'thesis',
  planName: 'Thesis',
  hostName: 'Camille',
  addresses: ['fe80::1', '192.168.1.24'],
  port: 47_314,
};

/** Renders the application with no project and opens the join window from the welcome screen. */
async function renderJoin(settings: Partial<CollaborationSettings> = {}) {
  const fake = fakeAppContext();
  fake.control.collaboration.settingsResult = {
    ok: true,
    value: { name: 'Noah', port: 47_313, firewallNoticeSeen: false, ...settings },
  };
  const app = new AppState(fake.context);
  const root = render(App, { app });
  click(button(root, `${english.welcome.join} ${english.welcome.joinHint}`));
  await settle();
  update();
  return { app, root, control: fake.control };
}

/** Gives the join window, failing the test when it is not open. */
function joinWindow(root: ParentNode): HTMLDialogElement {
  const dialog = single(root, 'dialog.join');
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) {
    throw new Error('The join window is not open');
  }
  return dialog;
}

/** Types a value in a field as a person does. */
function typeIn(root: ParentNode, selector: string, value: string): void {
  const field = single(root, selector);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`${selector} is not a field`);
  }
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  update();
}

/** Clicks Join and waits for what it started. */
async function pressJoin(root: ParentNode): Promise<void> {
  click(button(joinWindow(root), TEXT.join));
  await settle();
  update();
}

/** Gives the text of the message of the window, or null. */
function messageOf(root: ParentNode): string | null {
  return joinWindow(root).querySelector('[role="alert"]')?.textContent ?? null;
}

describe('joining a shared plan', () => {
  it('looks for plans nearby, saying when none shows up yet, with the name of this computer', async () => {
    const { root, control } = await renderJoin();
    const dialog = joinWindow(root);
    expect([
      single(dialog, 'h2').textContent,
      single(dialog, '.hint').textContent,
      (single(dialog, '#join-name') as HTMLInputElement).value,
      (single(dialog, '#join-port') as HTMLInputElement).value,
      control.collaboration.requests,
    ]).toEqual([
      TEXT.joinTitle,
      TEXT.noneNearby,
      'Noah',
      '47313',
      [['settings'], ['findPlans', true]],
    ]);
  });

  it('joins a plan found nearby at its IPv4 address with the code typed, telling a wrong code with the name of its host', async () => {
    const { root, app, control } = await renderJoin();
    control.collaboration.listener?.({ kind: 'nearbyPlans', plans: [NEARBY] });
    update();
    click(button(joinWindow(root), 'Thesis Camille'));
    expect(single(root, '.plan').getAttribute('aria-pressed')).toBe('true');
    typeIn(root, '#join-code', 'k7q-4mz');
    await pressJoin(root);
    expect(control.collaboration.requests.at(-1)).toEqual([
      'join',
      {
        address: '192.168.1.24',
        port: 47_314,
        code: 'K7Q4MZ',
        participantId: 'id1',
        name: 'Noah',
      },
    ]);
    expect([button(root, TEXT.joining).disabled, messageOf(root)]).toEqual([true, null]);
    control.collaboration.listener?.({ kind: 'ended', reason: 'WRONG_CODE' });
    update();
    expect([app.collaboration.mode, messageOf(root)]).toEqual([
      { kind: 'idle' },
      'This code did not work. Check it with Camille and type it again.',
    ]);
    control.collaboration.listener?.({ kind: 'ended', reason: 'CODE_REPLACED' });
    update();
    expect(messageOf(root)).toBe(
      'This code is no longer valid: too many wrong tries. Ask Camille for the new one.',
    );
  });

  it('joins by an address typed, naming the host plainly when it is not known', async () => {
    const { root, control } = await renderJoin();
    control.collaboration.listener?.({ kind: 'nearbyPlans', plans: [NEARBY] });
    update();
    click(button(joinWindow(root), 'Thesis Camille'));
    typeIn(root, '#join-address', ' 10.0.0.7 ');
    typeIn(root, '#join-code', 'K7Q4MZ');
    expect(single(root, '.plan').getAttribute('aria-pressed')).toBe('false');
    await pressJoin(root);
    control.collaboration.listener?.({ kind: 'ended', reason: 'UNREACHABLE' });
    update();
    expect([control.collaboration.requests.at(-1)?.[1], messageOf(root)]).toEqual([
      { address: '10.0.0.7', port: 47_314, code: 'K7Q4MZ', participantId: 'id1', name: 'Noah' },
      'Tasklace could not reach the person who shares it at this address. Check the address and the port, and that you are on the same network.',
    ]);
  });

  it('refuses what cannot be used to join before asking the main process', async () => {
    const { root, control } = await renderJoin({ name: null });
    await pressJoin(root);
    expect(messageOf(root)).toBe(TEXT.noName);
    typeIn(root, '#join-name', 'Noah');
    await pressJoin(root);
    expect(messageOf(root)).toBe(TEXT.invalidCode);
    typeIn(root, '#join-code', 'K7Q4M0');
    await pressJoin(root);
    expect(messageOf(root)).toBe(TEXT.invalidCode);
    typeIn(root, '#join-code', 'K7Q4MZ');
    await pressJoin(root);
    expect(messageOf(root)).toBe(TEXT.noTarget);
    typeIn(root, '#join-address', '10.0.0.7');
    typeIn(root, '#join-port', '70000');
    await pressJoin(root);
    expect(messageOf(root)).toBe('Type a port from 1 to 65535.');
    typeIn(root, '#join-port', '');
    await pressJoin(root);
    expect(messageOf(root)).toBe('Type a port from 1 to 65535.');
    expect(control.collaboration.requests).toEqual([['settings'], ['findPlans', true]]);
  });

  it('keeps a new name first, telling one it could not keep, and tells why the main process could not join', async () => {
    const { root, control } = await renderJoin({ name: null });
    typeIn(root, '#join-name', ' Noah ');
    typeIn(root, '#join-code', 'K7Q4MZ');
    typeIn(root, '#join-address', 'pc-camille.local');
    control.collaboration.saveSettingsResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await pressJoin(root);
    expect(messageOf(root)).toBe(TEXT.nameNotKept);
    control.collaboration.saveSettingsResult = { ok: true, value: null };
    control.collaboration.joinResult = { ok: false, error: { code: 'INVALID_ADDRESS' } };
    await pressJoin(root);
    expect(messageOf(root)).toBe(english.fileErrors.INVALID_ADDRESS);
    expect(control.collaboration.requests.slice(2)).toEqual([
      ['saveSettings', { name: 'Noah', port: 47_313, firewallNoticeSeen: false }],
      ['saveSettings', { name: 'Noah', port: 47_313, firewallNoticeSeen: false }],
      [
        'join',
        {
          address: 'pc-camille.local',
          port: 47_313,
          code: 'K7Q4MZ',
          participantId: 'id1',
          name: 'Noah',
        },
      ],
    ]);
  });

  it('joins nothing when the user cancels the question about the open project', async () => {
    const fake = fakeAppContext();
    fake.control.collaboration.settingsResult = {
      ok: true,
      value: { name: 'Noah', port: 47_313, firewallNoticeSeen: false },
    };
    const app = new AppState(fake.context);
    await app.newProject();
    expect(app.rename('Changed')).toBe(true);
    await settle();
    const root = render(App, { app });
    click(button(root, english.toolbar.open));
    const item = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent.trim() === english.toolbar.joinPlan,
    );
    if (item === undefined) {
      throw new Error('No join item in the Open menu');
    }
    click(item);
    await settle();
    update();
    typeIn(root, '#join-code', 'K7Q4MZ');
    typeIn(root, '#join-address', '10.0.0.7');
    click(button(joinWindow(root), TEXT.join));
    await settle();
    app.closePrompt?.answer('cancel');
    await settle();
    update();
    expect([messageOf(root), button(root, TEXT.join).disabled]).toEqual([null, false]);
    expect(fake.control.collaboration.requests.map(([name]) => name)).toEqual([
      'settings',
      'findPlans',
    ]);
  });

  it('closes once the plan joined opens, and with Cancel or Escape, staying in the plan joined', async () => {
    const { root, app, control } = await renderJoin();
    control.collaboration.openSharedResult = openedProjectOf(PLAN, { fileName: '' });
    typeIn(root, '#join-code', 'K7Q4MZ');
    typeIn(root, '#join-address', '10.0.0.7');
    await pressJoin(root);
    control.collaboration.listener?.({ kind: 'connected' });
    control.collaboration.listener?.({
      kind: 'hostMessage',
      message: encodeMessage({ kind: 'update', update: Uint8Array.of(0, 0) }),
    });
    await settle();
    await settle();
    update();
    expect([app.collaborationWindow, single(root, 'dialog.join').hasAttribute('open')]).toEqual([
      null,
      false,
    ]);
    for (const close of [
      () => {
        click(button(joinWindow(root), TEXT.cancel));
      },
      () => {
        click(button(joinWindow(root), TEXT.close));
      },
      () => {
        joinWindow(root).dispatchEvent(new Event('cancel', { cancelable: true }));
        update();
      },
    ]) {
      await app.openJoin();
      update();
      close();
      await settle();
      expect(app.collaborationWindow).toBeNull();
    }
    expect(app.collaboration.mode).toEqual({ kind: 'guest', connected: true });
  });
});
