import { describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import type { SharedSession } from '../../core/shared/shared-session';
import { ANNOUNCED_EVENT_BYTES } from '../collaboration/paced-events';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const prepared = vi.hoisted(() => ({ names: [] as string[], failure: null as Error | null }));

vi.mock('../../core/shared/shared-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/shared/shared-session')>();
  return {
    ...original,
    openSharedSessionFromState: (state: Uint8Array) => {
      const opened = original.openSharedSessionFromState(state);
      if (!opened.ok) {
        return opened;
      }
      const session: SharedSession = {
        ...opened.value,
        prepareTrialCopy: () => {
          prepared.names.push(opened.value.project().name);
          if (prepared.failure !== null) {
            throw prepared.failure;
          }
          opened.value.prepareTrialCopy();
        },
      };
      return { ok: true, value: session };
    },
  };
});

const FIRST = project([workTask('a')], [], { name: 'First' });
const SECOND = project([workTask('b')], [], { name: 'Second' });

/** Builds an application state whose paints the test releases one at a time, recording what the page tells at each paint asked. */
function pacedApp() {
  const fake = fakeAppContext();
  const paints: (() => void)[] = [];
  const app = new AppState({
    ...fake.context,
    waitForPaint: () =>
      new Promise((resolve) => {
        paints.push(resolve);
      }),
  });
  /** Lets the page paint for the paint asked at a place among those waiting, the oldest by default. */
  const paint = async (place = 0): Promise<void> => {
    const [next] = paints.splice(place, 1);
    if (next === undefined) {
      throw new Error('The page asked for no such paint.');
    }
    next();
    await settle();
  };
  return { app, paint, ...fake };
}

describe('waiting on a large plan', () => {
  it('tells that it opens before reading the plan, then gets the plan ready once the plan is painted', async () => {
    prepared.names = [];
    const { app, paint, control } = pacedApp();
    control.openResult = openedProjectOf(FIRST);
    const opening = app.open();
    await settle();
    expect([app.waiting, app.project]).toEqual(['opening', null]);
    await paint();
    await opening;
    expect([app.waiting, app.project?.name]).toEqual(['preparing', 'First']);
    expect(prepared.names).toEqual([]);
    await paint();
    expect(app.waiting).toBeNull();
    expect(prepared.names).toEqual(['First']);
  });

  it('gets ready only the plan still open, telling it waits until the last opened one is ready', async () => {
    prepared.names = [];
    const { app, paint, control } = pacedApp();
    control.openResult = openedProjectOf(FIRST);
    const first = app.open();
    await settle();
    await paint();
    await first;
    control.openResult = openedProjectOf(SECOND);
    const second = app.open();
    await settle();
    expect(app.waiting).toBe('opening');
    await paint(1);
    await second;
    expect([app.waiting, app.project?.name]).toEqual(['preparing', 'Second']);
    await paint();
    expect([app.waiting, prepared.names]).toEqual(['preparing', []]);
    await paint();
    expect([app.waiting, prepared.names]).toEqual([null, ['Second']]);
  });

  it('tells that it receives changes while a large one waits for the page to paint, the opening telling first', async () => {
    const { app, paint, control } = pacedApp();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      control.collaboration.listener?.({
        kind: 'peerMessage',
        peer: 1,
        message: new Uint8Array(ANNOUNCED_EVENT_BYTES),
      });
      await settle();
      expect(app.waiting).toBe('receiving');
      control.openResult = openedProjectOf(FIRST);
      const opening = app.open();
      await settle();
      expect(app.waiting).toBe('opening');
      await paint();
      expect(app.waiting).toBe('opening');
      expect(warned.mock.calls).toEqual([
        ['A message came from a guest no longer in the shared plan.'],
      ]);
      await paint();
      await opening;
      expect(app.waiting).toBe('preparing');
      await paint();
      expect(app.waiting).toBeNull();
    } finally {
      warned.mockRestore();
    }
  });

  it('opens the plan even when the page cannot wait to paint, leaving the trial copy to its first use and logging why', async () => {
    prepared.names = [];
    const fake = fakeAppContext();
    const app = new AppState({
      ...fake.context,
      waitForPaint: () => Promise.reject(new Error('No frame')),
    });
    fake.control.openResult = openedProjectOf(FIRST);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await app.open();
      await settle();
      expect([app.waiting, app.project?.name, prepared.names]).toEqual([null, 'First', []]);
      expect(logged.mock.calls).toEqual([
        ['The page could not paint before opening the plan:', new Error('No frame')],
        ['The plan could not be got ready to take changes:', new Error('No frame')],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('stops telling that it gets the plan ready when getting it ready throws, logging why', async () => {
    prepared.names = [];
    prepared.failure = new Error('Out of memory');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { app, paint, control } = pacedApp();
      control.openResult = openedProjectOf(FIRST);
      const opening = app.open();
      await settle();
      await paint();
      await opening;
      await paint();
      expect([app.waiting, prepared.names]).toEqual([null, ['First']]);
      expect(logged.mock.calls).toEqual([
        ['The plan could not be got ready to take changes:', new Error('Out of memory')],
      ]);
    } finally {
      prepared.failure = null;
      logged.mockRestore();
    }
  });
});
