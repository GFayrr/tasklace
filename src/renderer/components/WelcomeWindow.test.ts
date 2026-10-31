import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import type { FileAssociation } from '../../preload/bridge-contract';
import { AppState } from '../app/app-state.svelte';
import {
  fakeAppContext,
  openedAppOf,
  relayRequests,
  settle,
} from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { button, click, press, render, single, update } from './testing/render';

const TEXT = english.setup;
const LINK = `tasklace://relay.example.org/#e1.${'A'.repeat(86)}`;
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Gives a dialog by its class, failing the test when it is not a dialog. */
function dialogOf(root: ParentNode, selector: string): HTMLDialogElement {
  const dialog = single(root, selector);
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error(`${selector} is not a dialog`);
  }
  return dialog;
}

/** Gives a switch by the id of its label. */
function switchOf(root: ParentNode, labelId: string): HTMLElement {
  return single(root, `[role="switch"][aria-labelledby="${labelId}"]`);
}

/** Clicks an element and waits for what it started. */
async function clickAndSettle(element: HTMLElement): Promise<void> {
  click(element);
  await settle();
  await settle();
  update();
}

describe('the welcome window of the portable version', () => {
  it('asks both choices, ticked, before anything is sent, and cannot be dismissed with Escape', async () => {
    const fake = fakeAppContext();
    fake.control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    };
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.startSetup();
    update();
    const dialog = dialogOf(root, 'dialog.welcome-window');
    expect(dialog.open).toBe(true);
    expect(single(dialog, 'h2').textContent).toBe('Welcome to Tasklace');
    expect(
      [...dialog.querySelectorAll('h3, .hint')].map((element) => element.textContent.trim()),
    ).toEqual([
      TEXT.welcomeIntro,
      'Open Tasklace files and links with this copy',
      TEXT.associateHint,
      'Check for new versions',
      TEXT.checkHint,
    ]);
    expect(switchOf(dialog, 'welcome-associate-title').getAttribute('aria-checked')).toBe('true');
    expect(switchOf(dialog, 'welcome-check-title').getAttribute('aria-checked')).toBe('true');
    expect(fake.control.updates.requests).toEqual([]);
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    press(document.body, 'n', { ctrlKey: true });
    await settle();
    expect(fake.control.calls).toEqual([]);
  });

  it('gives the choices the person made, then closes and lets the check run', async () => {
    const fake = fakeAppContext();
    fake.control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    };
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.startSetup();
    update();
    const dialog = dialogOf(root, 'dialog.welcome-window');
    click(switchOf(dialog, 'welcome-check-title'));
    update();
    expect(switchOf(dialog, 'welcome-check-title').getAttribute('aria-checked')).toBe('false');
    click(switchOf(dialog, 'welcome-associate-title'));
    click(switchOf(dialog, 'welcome-associate-title'));
    await clickAndSettle(button(dialog, TEXT.continue));
    expect(fake.control.setup.requests).toEqual([
      ['setupState'],
      ['finishWelcome', { associate: true, checkForNewVersions: false }],
      ['takeOutsideRequest'],
    ]);
    expect(dialog.open).toBe(false);
    expect(fake.control.updates.requests.at(-1)).toEqual(['checkAtLaunch']);
  });

  it('opens the privacy policy, telling when the browser could not', async () => {
    const fake = fakeAppContext();
    fake.control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    };
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.startSetup();
    update();
    const dialog = dialogOf(root, 'dialog.welcome-window');
    await clickAndSettle(button(dialog, english.tasklace.privacyPolicy));
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    fake.control.updates.privacyResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, english.tasklace.privacyPolicy));
    expect(single(dialog, '[role="alert"]').textContent).toBe(english.tasklace.notOpened);
    expect(fake.control.updates.requests).toEqual([['openPrivacyPolicy'], ['openPrivacyPolicy']]);
  });

  it('stays closed in a copy that needs no welcome', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.startSetup();
    update();
    expect(dialogOf(root, 'dialog.welcome-window').open).toBe(false);
  });
});

describe('the files and links part of the Tasklace settings', () => {
  /** Opens the Tasklace settings with the copy that opens project files. */
  async function settingsWith(association: FileAssociation) {
    const fake = fakeAppContext();
    fake.control.setup.stateResult = { ok: true, value: { welcome: false, association } };
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.startSetup();
    app.openTasklaceSettings();
    await settle();
    update();
    return { app, root, dialog: dialogOf(root, 'dialog.tasklace-settings'), ...fake };
  }

  it('is not shown in a copy that opens no files', async () => {
    const { dialog } = await settingsWith({ kind: 'unavailable' });
    expect(dialog.querySelector('#tasklace-files-title')).toBeNull();
  });

  it('tells that this copy opens them, and stops it', async () => {
    const { dialog, control } = await settingsWith({ kind: 'thisCopy' });
    expect(single(dialog, '#tasklace-files-title').textContent).toBe('Files and links');
    const toggle = switchOf(dialog, 'tasklace-associate-title');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(single(dialog, '#tasklace-files-title ~ .hint').textContent).toBe(TEXT.thisCopy);
    control.setup.associationResult = { ok: true, value: { kind: 'none' } };
    await clickAndSettle(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(single(dialog, '#tasklace-files-title ~ .hint').textContent).toBe(TEXT.noCopy);
    expect(control.setup.requests.at(-1)).toEqual(['setFileAssociation', false]);
  });

  it('names the other copy that opens them, and takes them back', async () => {
    const path = 'C:\\Users\\Lea\\Downloads\\Tasklace-0.1.0-portable.exe';
    const { dialog, control } = await settingsWith({ kind: 'otherCopy', path });
    const toggle = switchOf(dialog, 'tasklace-associate-title');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(single(dialog, '#tasklace-files-title ~ .hint').textContent).toBe(TEXT.otherCopy);
    expect(single(dialog, '.path').textContent).toBe(path);
    control.setup.stateResult = {
      ok: true,
      value: { welcome: false, association: { kind: 'otherCopy', path } },
    };
    await clickAndSettle(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(control.setup.requests.at(-1)).toEqual(['setFileAssociation', true]);
  });

  it('tells when this copy could not be changed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { dialog, control } = await settingsWith({ kind: 'none' });
    control.setup.associationResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await clickAndSettle(switchOf(dialog, 'tasklace-associate-title'));
    expect(single(dialog, '[role="alert"]').textContent).toBe(TEXT.notChanged);
  });
});

describe('a link opened from outside', () => {
  it('fills the join window and warns where it came from, joining nothing until “Join”', async () => {
    const { app, control } = await openedAppOf(PLAN);
    render(App, { app });
    control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    await app.takeOutsideRequest();
    update();
    const dialog = dialogOf(document.body, 'dialog.join');
    expect(dialog.open).toBe(true);
    expect(single(dialog, '.outside').textContent).toBe(
      'You opened a link from outside Tasklace. Join only if you expected it.',
    );
    const field = single(dialog, '#join-link');
    expect(field instanceof HTMLInputElement && field.value).toBe(LINK);
    expect(relayRequests(control)).toEqual([]);
  });

  it('fills a join window already open with a new link from outside', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    const root = render(App, { app });
    await app.openJoin();
    update();
    const dialog = dialogOf(root, 'dialog.join');
    expect(dialog.querySelector('.outside')).toBeNull();
    fake.control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    await app.takeOutsideRequest();
    update();
    const field = single(dialog, '#join-link');
    expect(field instanceof HTMLInputElement && field.value).toBe(LINK);
    expect(single(dialog, '.outside').textContent).toBe(TEXT.outsideLink);
    click(button(dialog, english.collaboration.cancel));
    update();
    await app.openJoin();
    update();
    expect(dialog.querySelector('.outside')).toBeNull();
    const reopened = single(dialog, '#join-link');
    expect(reopened instanceof HTMLInputElement && reopened.value).toBe('');
  });
});
