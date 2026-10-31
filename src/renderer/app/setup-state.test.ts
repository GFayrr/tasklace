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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds the state of the setup over a fake bridge, with the control of its answers. */
function setupOf() {
  const fake = fakeAppContext();
  return { setup: new SetupState(fake.context.bridge), ...fake };
}

describe('SetupState', () => {
  it('knows nothing until it asks the main process, then whether to welcome and which copy opens files', async () => {
    const { setup, control } = setupOf();
    expect([setup.welcome, setup.association]).toEqual([false, null]);
    control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'otherCopy', path: 'D:\\Tasklace.exe' } },
    };
    await setup.load();
    expect([setup.welcome, setup.association]).toEqual([
      true,
      { kind: 'otherCopy', path: 'D:\\Tasklace.exe' },
    ]);
  });

  it('logs a setup it cannot read, keeping the welcome closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    control.setup.stateResult = { ok: false, error: { code: 'READ_FAILED' } };
    await setup.load();
    expect([setup.welcome, setup.association]).toEqual([false, null]);
    expect(warn.mock.calls).toEqual([['The setup of Tasklace could not be read:', 'READ_FAILED']]);
  });

  it('closes the welcome at once and tells whether its choices were applied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    };
    await setup.load();
    const finishing = setup.finishWelcome(CHOICES);
    expect(setup.welcome).toBe(false);
    expect(await finishing).toBe(true);
    expect(setup.association).toEqual({ kind: 'thisCopy' });
    control.setup.finishResult = { ok: true, value: { kind: 'none' } };
    expect(await setup.finishWelcome(CHOICES)).toBe(false);
    expect(await setup.finishWelcome({ ...CHOICES, associate: false })).toBe(true);
    control.setup.finishResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await setup.finishWelcome(CHOICES)).toBe(false);
    expect(setup.association).toEqual({ kind: 'none' });
    expect(control.setup.requests.slice(1)).toEqual([
      ['finishWelcome', CHOICES],
      ['finishWelcome', CHOICES],
      ['finishWelcome', { ...CHOICES, associate: false }],
      ['finishWelcome', CHOICES],
    ]);
    expect(warn.mock.calls).toEqual([
      ['The choices of the welcome window could not be applied:', 'WRITE_FAILED'],
    ]);
  });

  it('turns this copy on or off for files and links, telling whether it now does what was asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { setup, control } = setupOf();
    expect(await setup.setAssociation(true)).toBe(true);
    control.setup.associationResult = { ok: true, value: { kind: 'none' } };
    expect(await setup.setAssociation(false)).toBe(true);
    expect(await setup.setAssociation(true)).toBe(false);
    expect(setup.association).toEqual({ kind: 'none' });
    control.setup.associationResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(await setup.setAssociation(true)).toBe(false);
    expect(setup.association).toEqual({ kind: 'none' });
    expect(warn.mock.calls).toEqual([
      ['The copy that opens project files could not be changed:', 'WRITE_FAILED'],
    ]);
  });
});

describe('AppState and the setup', () => {
  it('holds back what came from outside and the check for new versions until the welcome got its answer', async () => {
    const { context, control } = fakeAppContext();
    control.setup.stateResult = {
      ok: true,
      value: { welcome: true, association: { kind: 'none' } },
    };
    control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    const app = new AppState(context);
    await app.startSetup();
    expect(control.setup.requests).toEqual([['setupState']]);
    expect(control.updates.requests).toEqual([]);
    expect(app.collaborationWindow).toBeNull();
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
    const { context, control } = fakeAppContext();
    control.setup.outsideResults = [{ ok: true, value: { kind: 'link', link: LINK } }];
    const app = new AppState(context);
    await app.takeOutsideRequest();
    expect([app.collaborationWindow, app.outsideLink]).toEqual(['join', LINK]);
    expect(relayRequests(control)).toEqual([]);
    expect(control.collaboration.requests).toEqual([['settings'], ['findPlans', true]]);
    app.closeCollaborationWindow();
    expect([app.collaborationWindow, app.outsideLink]).toEqual([null, null]);
  });

  it('opens a project file from outside like a file chosen to open, after the question about the open project', async () => {
    const { app, control } = await openedAppOf(PLAN);
    control.setup.outsideResults = [{ ok: true, value: { kind: 'file' } }];
    control.setup.outsideFileResult = openedProjectOf(OUTSIDE_PLAN);
    await app.takeOutsideRequest();
    await settle();
    expect(app.project?.name).toBe('Report');
    expect(control.setup.requests).toEqual([['takeOutsideRequest'], ['openOutsideFile']]);
  });

  it('keeps a changed project without file when the question about it is cancelled', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    await app.newProject();
    expect(app.rename('Changed')).toBe(true);
    await settle();
    control.setup.outsideResults = [{ ok: true, value: { kind: 'file' } }];
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
    const { context, control } = fakeAppContext();
    control.setup.outsideResults = [{ ok: false, error: { code: 'TASK_FAILED' } }];
    const app = new AppState(context);
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
});
