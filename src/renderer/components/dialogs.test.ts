import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../app/app-state.svelte';
import { project } from '../../core/testing/project-builder';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import ClosePrompt from './ClosePrompt.svelte';
import Notices from './Notices.svelte';
import ReportDialog from './ReportDialog.svelte';
import { button, click, dialogIn, nth, render, single, update } from './testing/render';

/** Creates the application state around a fake main process. */
function createApp(): AppState {
  return new AppState(fakeAppContext().context);
}

/** Shows an error message and a warning. */
function withMessages(app: AppState): void {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  app.reportUnexpectedError(new Error('x'));
  app.reportPickerUnavailable(new Error('y'));
  vi.restoreAllMocks();
}

describe('Notices', () => {
  it('shows each message with its kind, an error as an alert', () => {
    const app = createApp();
    withMessages(app);
    const root = render(Notices, { app });
    const notices = [...root.querySelectorAll('.notice')];
    expect(
      notices.map((notice) => [notice.getAttribute('role'), notice.textContent.trim()]),
    ).toEqual([
      ['alert', english.notices.unexpectedError],
      ['status', english.notices.pickerUnavailable],
    ]);
  });

  it('removes a message when dismissed or once it has faded out', () => {
    const app = createApp();
    withMessages(app);
    const root = render(Notices, { app });
    click(nth(root, '.dismiss', 0));
    expect(app.notices.map((notice) => notice.text)).toEqual([english.notices.pickerUnavailable]);
    single(root, '.notice').dispatchEvent(new Event('animationend'));
    update();
    expect(app.notices).toEqual([]);
  });

  it('keeps a message with details on screen and opens its details', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = {
      ok: false,
      error: { code: 'INVALID_PROJECT', issues: [{ path: 'tasks[0].name', code: 'EMPTY_TEXT' }] },
    };
    await app.open();
    const root = render(Notices, { app });
    single(root, '.notice').dispatchEvent(new Event('animationend'));
    update();
    expect(app.notices.map((notice) => notice.text)).toEqual([english.fileErrors.INVALID_PROJECT]);
    click(button(root, english.notices.details));
    expect(app.report?.entries).toEqual([`Task 1, name: ${english.issues.EMPTY_TEXT}`]);
    await settle();
  });
});

describe('ReportDialog', () => {
  it('lists the entries of a report and closes it', () => {
    const app = createApp();
    const root = render(ReportDialog, { app });
    const dialog = dialogIn(root);
    expect(dialog.open).toBe(false);
    app.openReport({ title: 'What changed', entries: ['First', 'Second'] });
    update();
    expect(dialog.open).toBe(true);
    expect(single(root, 'h2').textContent).toBe('What changed');
    expect([...root.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'First',
      'Second',
    ]);
    click(button(root, english.report.close));
    expect(app.report).toBeNull();
    expect(dialog.open).toBe(false);
  });

  it('forgets the report when the dialog is closed with Escape', () => {
    const app = createApp();
    const root = render(ReportDialog, { app });
    app.openReport({ title: 'T', entries: [] });
    update();
    const dialog = dialogIn(root);
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    update();
    expect(app.report).toBeNull();
  });
});

describe('ClosePrompt', () => {
  it('asks whether to save a project without file, with its three answers', async () => {
    const { context } = fakeAppContext();
    const app = new AppState(context);
    await app.newProject();
    app.rename('Changed');
    await settle();
    const root = render(ClosePrompt, { app });
    for (const [label, expected] of [
      [english.closePrompt.cancel, false],
      [english.closePrompt.discard, true],
    ] as const) {
      const ready = app.readyToClose();
      await settle();
      update();
      expect(single(root, 'h2').textContent).toBe(english.closePrompt.title);
      expect(dialogIn(root).open).toBe(true);
      click(button(root, label));
      expect(await ready).toBe(expected);
    }
    const saving = app.readyToClose();
    await settle();
    update();
    click(button(root, english.closePrompt.save));
    expect(await saving).toBe(true);
  });

  it('explains a failed last save with its reason and offers to save elsewhere or close anyway', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(project([], [], { name: 'Plan' }));
    await app.open();
    app.rename('Changed');
    await settle();
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const root = render(ClosePrompt, { app });
    const closing = app.prepareClose();
    await settle();
    update();
    expect(single(root, 'h2').textContent).toBe(english.closePrompt.failedTitle);
    expect(single(root, 'p').textContent).toContain(english.fileErrors.WRITE_FAILED);
    expect(button(root, english.closePrompt.saveElsewhere).classList.contains('primary')).toBe(
      true,
    );
    click(button(root, english.closePrompt.closeAnyway));
    expect(await closing).toBe(true);
  });

  it('cancels when the prompt is dismissed with Escape', async () => {
    const { context } = fakeAppContext();
    const app = new AppState(context);
    await app.newProject();
    app.rename('Changed');
    await settle();
    const root = render(ClosePrompt, { app });
    const ready = app.readyToClose();
    await settle();
    update();
    const cancel = new Event('cancel', { cancelable: true });
    single(root, 'dialog').dispatchEvent(cancel);
    update();
    expect(cancel.defaultPrevented).toBe(true);
    expect(await ready).toBe(false);
  });
});
