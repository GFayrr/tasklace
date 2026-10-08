import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAppContext, settle } from './testing/fake-app-context';
import { listenForUnexpectedErrors, startInterface } from './start-interface';
import type { AppState } from './app-state.svelte';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
});

/** Adds the application root the page is served with. */
function addRoot(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

/** Starts the interface with a fake bridge whose close requests are kept, returning the state it started. */
async function started() {
  const fake = fakeAppContext();
  const captured: { app: AppState | null; flush: (() => Promise<boolean>) | null } = {
    app: null,
    flush: null,
  };
  const context = {
    ...fake.context,
    bridge: {
      ...fake.context.bridge,
      onFlushRequested: (next: () => Promise<boolean>) => {
        captured.flush = next;
      },
    },
  };
  const root = addRoot();
  const calls: string[] = [];
  await startInterface(document, context, (running) => {
    calls.push(...fake.control.calls);
    captured.app = running;
  });
  const { app, flush } = captured;
  if (app === null || flush === null) {
    throw new Error('The interface did not start.');
  }
  return { app, flush, root, calls, ...fake };
}

describe('startInterface', () => {
  it('refuses a page without the application root', async () => {
    await expect(
      startInterface(document, fakeAppContext().context, () => undefined),
    ).rejects.toThrow('The page has no application root.');
  });

  it('applies the theme, shows the interface, tells the caller before loading the recent projects, and marks the root started', async () => {
    const { root, calls, control } = await started();
    expect(document.documentElement.style.getPropertyValue('--color-background')).toBe('#F7F6F3');
    expect(root.dataset['started']).toBe('true');
    expect(root.querySelectorAll('.welcome')).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(control.calls).toEqual(['recentProjects']);
  });

  it('answers a request to close by preparing the close, and keeps the window open after an unexpected error, reporting it', async () => {
    const { app, flush } = await started();
    expect(await flush()).toBe(true);
    const fault = new Error('broken on purpose');
    vi.spyOn(app, 'prepareClose').mockRejectedValueOnce(fault);
    const reported = vi.spyOn(app, 'reportUnexpectedError').mockImplementation(() => undefined);
    expect(await flush()).toBe(false);
    expect(reported).toHaveBeenCalledWith(fault);
  });
});

describe('listenForUnexpectedErrors', () => {
  it('reports a rejected promise nothing handled, marking it handled, and an error with its object or its place', async () => {
    const target = new EventTarget() as Pick<Window, 'addEventListener'> & EventTarget;
    const reported: unknown[] = [];
    listenForUnexpectedErrors(target, (error) => reported.push(error));
    const rejection = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: 'lost',
    });
    target.dispatchEvent(rejection);
    const fault = new Error('thrown');
    target.dispatchEvent(Object.assign(new Event('error'), { error: fault }));
    target.dispatchEvent(
      Object.assign(new Event('error'), {
        error: null,
        message: 'Script error',
        filename: 'app.js',
        lineno: 3,
        colno: 7,
      }),
    );
    await settle();
    expect(rejection.defaultPrevented).toBe(true);
    expect(reported).toEqual(['lost', fault, 'Script error (app.js:3:7)']);
  });
});
