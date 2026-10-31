import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { SetupState } from './setup-state.svelte';
import {
  fakeAppContext,
  openedAppOf,
  openedProjectOf,
  relayRequests,
  settle,
} from './testing/fake-app-context';

const LINK = 'tasklace://relay.school.example/#e1.key';
const PLAN = project([workTask('a', { name: 'Survey' })], [], { name: 'Thesis' });
const OUTSIDE_PLAN = project([workTask('b', { name: 'Draft' })], [], { name: 'Report' });
const CHOICES = { associate: true, checkForNewVersions: false };
const WELCOME = { ok: true, value: { welcome: true, association: { kind: 'none' } } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds the state of the setup over a fake bridge, with the control of its answers. */
function setupOf() {
  const fake = fakeAppContext();
  return { setup: new SetupState(fake.context.bridge), ...fake };
}

/** Builds the state of the application with its setup loaded, as it is once the page started. */
async function startedApp() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  await app.setup.load();
  fake.control.setup.requests.length = 0;
  return { app, ...fake };
}

describe('SetupState', () => {
  it('knows nothing until it asks the main process, then whether to welcome and which copy opens files', async () => {
    const { setup, control } = setupOf();
    expect([setup.isLoaded, setup.welcome, setup.association]).toEqual([false, false, null]);
    control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'otherCopy', path: 'D:\\Tasklace.exe' } },
    };
    expect(await setup.load()).toBe(true);
    expect([setup.isLoaded, setup.welcome, setup.association]).toEqual([
      true,
      true,
      { kind: 'otherCopy', path: 'D:\\Tasklace.exe' },
    ]);
  });

  it('logs a setup it cannot read, keeping the welcome closed but counting the setup as asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    control.setup.stateResult = { ok: false, error: { code: 'READ_FAILED' } };
    expect(await setup.load()).toBe(false);
    expect([setup.isLoaded, setup.welcome, setup.association]).toEqual([true, false, null]);
    expect(warn.mock.calls).toEqual([['The setup of Tasklace could not be read:', 'READ_FAILED']]);
  });

  it('closes the welcome at once and tells whether its choices were applied, asking again which copy opens files when they were not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    control.setup.stateResult = WELCOME;
    await setup.load();
    const finishing = setup.finishWelcome(CHOICES);
    expect(setup.welcome).toBe(false);
    expect(await finishing).toBe(true);
    expect(setup.association).toEqual({ kind: 'thisCopy' });
    control.setup.finishResult = { ok: true, value: { kind: 'none' } };
    expect(await setup.finishWelcome(CHOICES)).toBe(false);
    expect(await setup.finishWelcome({ ...CHOICES, associate: false })).toBe(true);
    control.setup.finishResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    control.setup.stateResult = {
      ok: true,
      value: { welcome: false, association: { kind: 'unknown' } },
    };
    expect(await setup.finishWelcome(CHOICES)).toBe(false);
    expect([setup.welcome, setup.association]).toEqual([false, { kind: 'unknown' }]);
    expect(control.setup.requests.slice(1)).toEqual([
      ['finishWelcome', CHOICES],
      ['finishWelcome', CHOICES],
      ['finishWelcome', { ...CHOICES, associate: false }],
      ['finishWelcome', CHOICES],
      ['setupState'],
    ]);
    expect(warn.mock.calls).toEqual([
      ['The choices of the welcome window could not be applied:', 'WRITE_FAILED'],
    ]);
  });

  it('turns this copy on or off for files and links, telling whether it now does what was asked and asking again after a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    expect(await setup.setAssociation(true)).toBe(true);
    control.setup.associationResult = { ok: true, value: { kind: 'none' } };
    expect(await setup.setAssociation(false)).toBe(true);
    expect(await setup.setAssociation(true)).toBe(false);
    expect(setup.association).toEqual({ kind: 'none' });
    control.setup.associationResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    control.setup.stateResult = {
      ok: true,
      value: { welcome: false, association: { kind: 'thisCopy' } },
    };
    expect(await setup.setAssociation(false)).toBe(false);
    expect(setup.association).toEqual({ kind: 'thisCopy' });
    expect(control.setup.requests.at(-1)).toEqual(['setupState']);
    expect(warn.mock.calls).toEqual([
      ['The copy that opens project files could not be changed:', 'WRITE_FAILED'],
    ]);
  });
});

describe('AppState and the setup', () => {
  it('holds back what came from outside and the check for new versions until the welcome got its answer', async () => {
    const { context, control } = fakeAppContext();
    control.setup.stateResult = WELCOME;
    control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    const app = new AppState(context);
    await app.takeOutsideRequest();
    expect(control.setup.requests).toEqual([]);
    await app.startSetup();
    expect(control.setup.requests).toEqual([['setupState']]);
    expect(control.updates.requests).toEqual([]);
    await app.takeOutsideRequest();
    expect(control.setup.requests).toEqual([['setupState']]);
    await app.finishWelcome(CHOICES);
    expect(control.setup.requests).toEqual([
      ['setupState'],
      ['finishWelcome', CHOICES],
      ['takeOutsideRequest'],
    ]);
    expect(control.updates.requests).toEqual([
      ['appVersion'],
      ['updateSettings'],
      ['checkAtLaunch'],
    ]);
    expect(app.collaborationWindow).toBe('join');
    expect(app.notices).toEqual([]);
  });

  it('takes what came from outside and checks for new versions at once when no welcome is needed', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    await app.startSetup();
    expect(control.setup.requests).toEqual([['setupState'], ['takeOutsideRequest']]);
    expect(control.updates.requests).toEqual([
      ['appVersion'],
      ['updateSettings'],
      ['checkAtLaunch'],
    ]);
  });

  it('tells the user when the choices of the welcome could not be kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { context, control } = fakeAppContext();
    control.setup.finishResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const app = new AppState(context);
    await app.finishWelcome(CHOICES);
    expect(app.notices.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'error', text: english.setup.notApplied },
    ]);
    expect(english.setup.notApplied).toBe(
      'Tasklace could not keep these choices on this computer. You can change them in Tasklace settings.',
    );
  });

  it('fills the join window with a link from outside, joining nothing until asked, and forgets it once the window closes', async () => {
    const { app, control } = await startedApp();
    control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    await app.takeOutsideRequest();
    expect([app.collaborationWindow, app.outsideLink]).toEqual(['join', LINK]);
    expect(relayRequests(control)).toEqual([]);
    expect(control.collaboration.requests).toEqual([['settings'], ['findPlans', true]]);
    app.closeCollaborationWindow();
    expect([app.collaborationWindow, app.outsideLink]).toEqual([null, null]);
  });

  it('tells the user of a link or a file from outside it could not read, without opening anything', async () => {
    const { app, control } = await startedApp();
    control.setup.outsideResults = [
      { ok: true, value: { kind: 'unreadable', what: 'link' } },
      { ok: true, value: { kind: 'unreadable', what: 'file' } },
    ];
    await app.takeOutsideRequest();
    await app.takeOutsideRequest();
    expect(app.collaborationWindow).toBeNull();
    expect(app.notices.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'warning', text: english.setup.linkUnreadable },
      { kind: 'warning', text: english.setup.fileUnreadable },
    ]);
    expect([english.setup.linkUnreadable, english.setup.fileUnreadable]).toEqual([
      'The link you opened is not the link of a shared plan, or it was cut. Ask the person who sent it for the whole link.',
      'Tasklace could not open this file from where it was opened. Open it with “Open…” instead.',
    ]);
  });

  it('opens a project file from outside under its number like a file chosen to open', async () => {
    const { app, control } = await openedAppOf(PLAN);
    await app.setup.load();
    control.setup.outsideResults = [{ ok: true, value: { kind: 'file', id: 3 } }];
    control.setup.outsideFileResult = openedProjectOf(OUTSIDE_PLAN);
    await app.takeOutsideRequest();
    await settle();
    expect(app.project?.name).toBe('Report');
    expect(control.setup.requests).toEqual([
      ['setupState'],
      ['takeOutsideRequest'],
      ['openOutsideFile', 3],
    ]);
  });

  it('takes the requests from outside one after the other, each file under its own number', async () => {
    const { app, control } = await startedApp();
    control.setup.outsideResults = [
      { ok: true, value: { kind: 'file', id: 1 } },
      { ok: true, value: { kind: 'file', id: 2 } },
    ];
    control.setup.outsideFileResult = openedProjectOf(OUTSIDE_PLAN);
    await Promise.all([app.takeOutsideRequest(), app.takeOutsideRequest()]);
    expect(control.setup.requests).toEqual([
      ['takeOutsideRequest'],
      ['openOutsideFile', 1],
      ['takeOutsideRequest'],
      ['openOutsideFile', 2],
    ]);
    expect(app.notices).toEqual([]);
  });

  it('keeps a changed project without file when the question about it is cancelled', async () => {
    const { app, control } = await startedApp();
    await app.newProject();
    expect(app.rename('Changed')).toBe(true);
    await settle();
    control.setup.outsideResults = [{ ok: true, value: { kind: 'file', id: 1 } }];
    const taking = app.takeOutsideRequest();
    await settle();
    expect(app.closePrompt?.reason).toBe('unsaved');
    app.closePrompt?.answer('cancel');
    await taking;
    expect(app.project?.name).toBe('Changed');
    expect(control.setup.requests).toEqual([['takeOutsideRequest']]);
  });

  it('logs a request from outside it could not take', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, control } = await startedApp();
    control.setup.outsideResults = [{ ok: false, error: { code: 'TASK_FAILED' } }];
    await app.takeOutsideRequest();
    expect(app.collaborationWindow).toBeNull();
    expect(error.mock.calls).toEqual([
      ['What Tasklace was started with could not be taken:', 'TASK_FAILED'],
    ]);
  });

  it('turns this copy on or off for files and links from the settings', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    expect(await app.setFileAssociation(true)).toBe(true);
    expect(control.setup.requests).toEqual([['setFileAssociation', true]]);
  });

  it('keeps a message that offers an action until it is dismissed', async () => {
    const { context, control } = fakeAppContext();
    control.updates.launchResult = { ok: true, value: { kind: 'newer', version: '0.2.0' } };
    const app = new AppState(context);
    await app.startUpdates();
    expect(app.notices.map(({ lasting }) => lasting)).toEqual([true]);
  });
});
