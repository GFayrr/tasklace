import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
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

const TEXT = english.tasklace;
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Renders the welcome screen once the version is known. */
async function renderWelcome() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  await app.startUpdates();
  const root = render(App, { app });
  return { app, root, ...fake };
}

/** Clicks an element and waits for what it started. */
async function clickAndSettle(element: HTMLElement): Promise<void> {
  click(element);
  await settle();
  update();
}

/** Finds the window of the settings of this computer. */
function settingsWindow(root: ParentNode): HTMLDialogElement {
  const dialog = single(root, 'dialog.tasklace-settings');
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error('Not a dialog');
  }
  return dialog;
}

describe('the settings of this computer', () => {
  it('opens from the foot of the welcome screen, which shows the version', async () => {
    const { root } = await renderWelcome();
    expect(single(root, '.welcome .footer').textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Tasklace 0.1.0 Tasklace settings',
    );
    click(button(root, TEXT.footerLink));
    const dialog = settingsWindow(root);
    expect(dialog.open).toBe(true);
    expect(single(dialog, 'h2').textContent).toBe('Tasklace settings');
    expect(single(dialog, '.part .row span').textContent).toBe('Tasklace 0.1.0');
    expect(single(dialog, '[role="switch"]').getAttribute('aria-checked')).toBe('true');
    expect(single(dialog, '.status').textContent.trim()).toBe('');
  });

  it('opens from the Tasklace menu of the toolbar, which also opens the guide to relays', async () => {
    const { app, control } = await openedAppOf(PLAN);
    await app.startUpdates();
    const root = render(App, { app });
    click(button(root, TEXT.menu));
    const items = [...root.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(items).toEqual(['Tasklace settings… Tasklace 0.1.0', 'Guide to setting up a relay']);
    await clickAndSettle(button(root, `${TEXT.settingsItem} Tasklace 0.1.0`));
    expect(settingsWindow(root).open).toBe(true);
    click(button(settingsWindow(root), TEXT.done));
    expect(settingsWindow(root).open).toBe(false);
    click(button(root, TEXT.menu));
    await clickAndSettle(button(root, TEXT.guideItem));
    expect(relayRequests(control)).toEqual([['openGuide']]);
  });

  it('shows the settings item without the version while the version is not known', async () => {
    const { app } = await openedAppOf(PLAN);
    const root = render(App, { app });
    click(button(root, TEXT.menu));
    expect(
      [...root.querySelectorAll('[role="menuitem"]')].map((item) =>
        item.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Tasklace settings…', 'Guide to setting up a relay']);
    expect(single(root, 'header.toolbar').querySelector('.footer')).toBeNull();
  });

  it('checks now and shows the result under the version: latest, newer with its page, or failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { root, control } = await renderWelcome();
    click(button(root, TEXT.footerLink));
    const dialog = settingsWindow(root);
    await clickAndSettle(button(dialog, TEXT.checkNow));
    expect(single(dialog, '.status').textContent.trim()).toBe(
      'This is the latest version. Checked at 10:00 AM.',
    );
    control.updates.checkNowResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    await clickAndSettle(button(dialog, TEXT.checkNow));
    expect(single(dialog, '.status').textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Tasklace 0.2.0 is available. Open the release page',
    );
    await clickAndSettle(button(dialog, english.notices.openReleasePage));
    expect(control.updates.requests.at(-1)).toEqual(['openReleasePage', '0.2.0']);
    control.updates.checkNowResult = { ok: true, value: { kind: 'failed', reason: 'malformed' } };
    await clickAndSettle(button(dialog, TEXT.checkNow));
    expect(single(dialog, '.status').textContent.trim()).toBe(TEXT.failed);
  });

  it('shows that a check runs, with its button disabled until the answer comes', async () => {
    const { root } = await renderWelcome();
    click(button(root, TEXT.footerLink));
    const dialog = settingsWindow(root);
    click(button(dialog, TEXT.checkNow));
    expect(single(dialog, '.status').textContent.trim()).toBe(TEXT.checking);
    expect(button(dialog, TEXT.checkNow).disabled).toBe(true);
    await settle();
    update();
    expect(button(dialog, TEXT.checkNow).disabled).toBe(false);
  });

  it('turns the check off, saying so, and tells when the choice cannot be kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { root, control } = await renderWelcome();
    click(button(root, TEXT.footerLink));
    const dialog = settingsWindow(root);
    await clickAndSettle(single(dialog, '[role="switch"]'));
    expect(single(dialog, '[role="switch"]').getAttribute('aria-checked')).toBe('false');
    expect(single(dialog, '.status').textContent.trim()).toBe(TEXT.checkOff);
    expect(control.updates.requests.at(-1)).toEqual(['setCheckForNewVersions', false]);
    control.updates.setCheckResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await clickAndSettle(single(dialog, '[role="switch"]'));
    expect(single(dialog, '[role="switch"]').getAttribute('aria-checked')).toBe('false');
    expect(single(dialog, '.problem').textContent).toBe(TEXT.notKept);
  });

  it('opens the privacy policy, telling when the browser could not open it, and forgets that when opened again', async () => {
    const { app, root, control } = await renderWelcome();
    click(button(root, TEXT.footerLink));
    const dialog = settingsWindow(root);
    expect(single(dialog, '.part p.hint').textContent.replace(/\s+/g, ' ').trim()).toBe(
      `${TEXT.checkHint} ${TEXT.privacyPolicy}`,
    );
    await clickAndSettle(button(dialog, TEXT.privacyPolicy));
    expect(dialog.querySelector('.problem')).toBeNull();
    control.updates.privacyResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await clickAndSettle(button(dialog, TEXT.privacyPolicy));
    expect(single(dialog, '.problem').textContent).toBe(TEXT.notOpened);
    app.closeTasklaceSettings();
    update();
    app.openTasklaceSettings();
    update();
    expect(dialog.querySelector('.problem')).toBeNull();
  });

  it('closes with Escape and keeps the shortcuts of the plan away while open', async () => {
    const { app } = await openedAppOf(PLAN);
    const rendered = render(App, { app });
    app.openTasklaceSettings();
    update();
    const run = vi.spyOn(app, 'run');
    press(document.body, 'z', { ctrlKey: true });
    expect(run.mock.calls).toEqual([]);
    const dialog = settingsWindow(rendered);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    update();
    expect(app.isTasklaceSettingsOpen).toBe(false);
    dialog.dispatchEvent(new Event('close'));
    expect(app.isTasklaceSettingsOpen).toBe(false);
  });
});

describe('the message of a new version', () => {
  it('offers to open the release page', async () => {
    const fake = fakeAppContext();
    fake.control.updates.launchResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    const app = new AppState(fake.context);
    await app.startUpdates();
    const root = render(App, { app });
    expect(single(root, '.notice p').textContent).toBe('Tasklace 0.2.0 is available.');
    await clickAndSettle(button(root, english.notices.openReleasePage));
    expect(fake.control.updates.requests.at(-1)).toEqual(['openReleasePage', '0.2.0']);
  });
});
