import { afterEach, describe, expect, it, vi } from 'vitest';
import english from '../locales/en.json';
import { FIXED_NOW, fakeAppContext, settle } from './testing/fake-app-context';
import { AppState } from './app-state.svelte';
import { UpdateState } from './update-state.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds the state of versions over a fake bridge, with the control of its answers. */
function updatesOf() {
  const fake = fakeAppContext();
  return { updates: new UpdateState(fake.context.bridge, () => FIXED_NOW), ...fake };
}

describe('UpdateState', () => {
  it('knows nothing until it asks the main process for the version and the setting', async () => {
    const { updates, control } = updatesOf();
    expect([updates.version, updates.checkForNewVersions, updates.status]).toEqual([
      null,
      null,
      { kind: 'idle' },
    ]);
    expect(await updates.load()).toBe(true);
    expect([updates.version, updates.checkForNewVersions]).toEqual(['0.1.0', true]);
    expect(control.updates.requests).toEqual([['appVersion'], ['updateSettings']]);
  });

  it('logs a version or a setting that cannot be read, keeping what is known', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates, control } = updatesOf();
    control.updates.settingsResult = { ok: false, error: { code: 'READ_FAILED' } };
    expect(await updates.load()).toBe(false);
    expect([updates.version, updates.checkForNewVersions]).toEqual(['0.1.0', null]);
    control.updates.versionResult = { ok: false, error: { code: 'TASK_FAILED' } };
    control.updates.settingsResult = { ok: true, value: { checkForNewVersions: false } };
    expect(await updates.load()).toBe(false);
    expect([updates.version, updates.checkForNewVersions]).toEqual(['0.1.0', false]);
    expect(warn.mock.calls).toEqual([
      ['The settings of new versions could not be read:', 'READ_FAILED'],
      ['The version of Tasklace could not be read:', 'TASK_FAILED'],
    ]);
  });

  it('gives the newer version the check at launch found, and nothing otherwise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates, control } = updatesOf();
    expect(await updates.checkAtLaunch()).toBeNull();
    control.updates.launchResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    expect(await updates.checkAtLaunch()).toBe('0.2.0');
    control.updates.launchResult = { ok: true, value: { kind: 'latest' } };
    expect(await updates.checkAtLaunch()).toBeNull();
    control.updates.launchResult = { ok: false, error: { code: 'READ_FAILED' } };
    expect(await updates.checkAtLaunch()).toBeNull();
    expect(warn.mock.calls).toEqual([
      ['The check for new versions at launch could not run:', 'READ_FAILED'],
    ]);
  });

  it('turns the check off and on, keeping the previous choice when this computer could not keep it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates, control } = updatesOf();
    await updates.load();
    expect(await updates.setCheck(false)).toBe(true);
    expect(updates.checkForNewVersions).toBe(false);
    control.updates.setCheckResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await updates.setCheck(true)).toBe(false);
    expect(updates.checkForNewVersions).toBe(false);
    expect(control.updates.requests.slice(2)).toEqual([
      ['setCheckForNewVersions', false],
      ['setCheckForNewVersions', true],
    ]);
    expect(warn.mock.calls).toEqual([
      ['The setting of new versions could not be kept:', 'WRITE_FAILED'],
    ]);
  });

  it('shows the result of a check asked now: latest with its time, newer, or failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates, control } = updatesOf();
    const checking = updates.checkNow();
    expect(updates.status).toEqual({ kind: 'checking' });
    await checking;
    expect(updates.status).toEqual({ kind: 'latest', checkedAt: FIXED_NOW });
    control.updates.checkNowResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    await updates.checkNow();
    expect(updates.status).toEqual({ kind: 'newer', version: '0.2.0' });
    control.updates.checkNowResult = { ok: true, value: { kind: 'failed' } };
    await updates.checkNow();
    expect(updates.status).toEqual({ kind: 'failed' });
    control.updates.checkNowResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await updates.checkNow();
    expect(updates.status).toEqual({ kind: 'failed' });
  });

  it('shows a failed check when the bridge itself fails, and throws its error again', async () => {
    const fault = new Error('bridge gone');
    const { context } = updatesOf();
    const failing = new UpdateState(
      { ...context.bridge, checkNow: () => Promise.reject(fault) },
      () => FIXED_NOW,
    );
    await expect(failing.checkNow()).rejects.toBe(fault);
    expect(failing.status).toEqual({ kind: 'failed' });
  });

  it('opens the release page and the privacy policy, telling whether they opened', async () => {
    const { updates, control } = updatesOf();
    expect(await updates.openReleasePage('0.2.0')).toBe(true);
    expect(await updates.openPrivacyPolicy()).toBe(true);
    control.updates.privacyResult = { ok: false, error: { code: 'TASK_FAILED' } };
    expect(await updates.openPrivacyPolicy()).toBe(false);
    expect(control.updates.requests).toEqual([
      ['openReleasePage', '0.2.0'],
      ['openPrivacyPolicy'],
      ['openPrivacyPolicy'],
    ]);
  });
});

describe('AppState and new versions', () => {
  it('opens and closes the settings of this computer', () => {
    const app = new AppState(fakeAppContext().context);
    expect(app.isTasklaceSettingsOpen).toBe(false);
    app.openTasklaceSettings();
    expect(app.isTasklaceSettingsOpen).toBe(true);
    app.closeTasklaceSettings();
    expect(app.isTasklaceSettingsOpen).toBe(false);
  });

  it('tells with a lasting message when the check at launch finds a newer version, and nothing otherwise', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    await app.startUpdates();
    expect(app.notices).toEqual([]);
    control.updates.launchResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    await app.startUpdates();
    expect(
      app.notices.map(({ kind, text, lasting, action }) => ({ kind, text, lasting, action })),
    ).toEqual([
      {
        kind: 'info',
        text: 'Tasklace 0.2.0 is available.',
        lasting: true,
        action: { kind: 'openReleasePage', version: '0.2.0' },
      },
    ]);
    expect(english.notices.newVersion).toBe('Tasklace {version} is available.');
  });

  it('opens the release page a message offers, telling when the browser could not open it', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    await app.runNoticeAction({ kind: 'openReleasePage', version: '0.2.0' });
    expect(app.notices).toEqual([]);
    control.updates.releasePageResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await app.runNoticeAction({ kind: 'openReleasePage', version: '0.2.0' });
    await settle();
    expect(app.notices.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'error', text: 'The browser could not open this page.' },
    ]);
  });
});
