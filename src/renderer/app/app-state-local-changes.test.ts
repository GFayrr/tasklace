import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createSharedDocument } from '../../core/shared/shared-document';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import {
  fakeAppContext,
  openedProjectOf,
  OPENED_DOCUMENT_ID,
  settle,
} from './testing/fake-app-context';

const PLAN = project([workTask('a', { name: 'Write' })], [], { name: 'Thesis' });

/** Starts opening a file whose local copy renamed the plan, or held the given bytes, until the question shows. */
async function opening(changes?: Uint8Array) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  const document = createSharedDocument(PLAN, OPENED_DOCUMENT_ID);
  const state = Y.encodeStateAsUpdate(document);
  document.getMap('project').set('name', 'Thesis, kept here');
  fake.control.openResult = openedProjectOf(PLAN, {
    state,
    localChanges: changes ?? Y.encodeStateAsUpdate(document),
  });
  const opened = app.open();
  await settle();
  return { app, opened, ...fake };
}

/** Returns the texts of the messages shown. */
function noticeTexts(app: AppState): string[] {
  return app.notices.map((notice) => notice.text);
}

describe('opening a file whose local copy holds changes it lacks', () => {
  it('asks about the changes, naming the file, and adds them when told', async () => {
    const { app, opened } = await opening();
    const prompt = app.closePrompt;
    prompt?.answer('save');
    await opened;
    expect([prompt?.reason, prompt?.reason === 'localChanges' && prompt.fileName]).toEqual([
      'localChanges',
      'Thesis.tasklace',
    ]);
    expect([app.project?.name, noticeTexts(app)]).toEqual([
      'Thesis, kept here',
      [english.notices.localChangesAdded],
    ]);
  });

  it('opens the file alone once its copy is set aside, telling nothing', async () => {
    const { app, opened, control } = await opening();
    app.closePrompt?.answer('discard');
    await opened;
    expect([app.project?.name, control.setAside, noticeTexts(app)]).toEqual([
      'Thesis',
      [OPENED_DOCUMENT_ID],
      [],
    ]);
  });

  it('keeps the open project when the user cancels', async () => {
    const { app, opened, control } = await opening();
    app.closePrompt?.answer('cancel');
    await opened;
    expect([app.project, control.adopted, noticeTexts(app)]).toEqual([null, [], []]);
  });

  it('tells, lastingly, that changes could not be added, and whether they were set aside', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = Uint8Array.of(255, 255, 255);
    const kept = await opening(broken);
    kept.app.closePrompt?.answer('save');
    await kept.opened;
    const lost = await opening(broken);
    lost.control.setAsideResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    lost.app.closePrompt?.answer('save');
    await lost.opened;
    expect([
      kept.app.notices.map((notice) => [notice.text, notice.kind, notice.lasting]),
      lost.app.notices.map((notice) => [notice.text, notice.kind, notice.lasting]),
    ]).toEqual([
      [[english.notices.localChangesNotAdded, 'error', true]],
      [[english.notices.localChangesLost, 'error', true]],
    ]);
    errors.mockRestore();
  });
});
