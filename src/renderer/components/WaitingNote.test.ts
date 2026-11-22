import { afterEach, describe, expect, it } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import App from './App.svelte';
import { render, single, unmountAll, update } from './testing/render';

afterEach(() => {
  unmountAll();
});

describe('WaitingNote', () => {
  it('tells on the welcome screen that a plan opens, then on the plan that it gets ready, then nothing', async () => {
    const fake = fakeAppContext();
    const paints: (() => void)[] = [];
    const app = new AppState({
      ...fake.context,
      waitForPaint: () =>
        new Promise((resolve) => {
          paints.push(resolve);
        }),
    });
    const root = render(App, { app });
    /** Returns the text the page shows about what it waits for. */
    const shown = (): string => single(root, '.waiting').textContent.trim();
    expect(shown()).toBe('');
    fake.control.openResult = openedProjectOf(project([workTask('a')]));
    const opening = app.open();
    await settle();
    update();
    expect(shown()).toBe(english.waiting.opening);
    paints.shift()?.();
    await opening;
    update();
    expect(shown()).toBe(english.waiting.preparing);
    paints.shift()?.();
    await settle();
    update();
    expect(shown()).toBe('');
  });
});
