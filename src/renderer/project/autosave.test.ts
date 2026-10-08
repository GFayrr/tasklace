import { describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DELAY_MS, createAutosave } from './autosave';
import { manualTimer } from './testing/manual-timer';
import { settle } from '../app/testing/fake-app-context';

describe('createAutosave', () => {
  it('waits two seconds after the last change with the timer of the page', async () => {
    vi.useFakeTimers();
    try {
      let saves = 0;
      const autosave = createAutosave(
        () => {
          saves += 1;
          return Promise.resolve();
        },
        () => undefined,
      );
      autosave.changed();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
      autosave.changed();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
      expect(saves).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves once after the last of several changes', async () => {
    const timer = manualTimer();
    let saves = 0;
    const autosave = createAutosave(
      () => {
        saves += 1;
        return Promise.resolve();
      },
      () => undefined,
      timer,
    );
    autosave.changed();
    autosave.changed();
    autosave.changed();
    expect(saves).toBe(0);
    timer.fire();
    await settle();
    expect(saves).toBe(1);
    expect(timer.pending()).toBe(false);
  });

  it('saves at once on demand, and does nothing when nothing changed', async () => {
    const timer = manualTimer();
    let saves = 0;
    const autosave = createAutosave(
      () => {
        saves += 1;
        return Promise.resolve();
      },
      () => undefined,
      timer,
    );
    await autosave.flush();
    expect(saves).toBe(0);
    autosave.changed();
    await autosave.flush();
    expect(saves).toBe(1);
    expect(timer.pending()).toBe(false);
  });

  it('saves again for a change made during a save, and waits for it on demand', async () => {
    const timer = manualTimer();
    const events: string[] = [];
    let finishFirst: () => void = () => undefined;
    let calls = 0;
    const autosave = createAutosave(
      () => {
        calls += 1;
        events.push(`start ${String(calls)}`);
        return calls === 1
          ? new Promise<void>((resolve) => {
              finishFirst = () => {
                events.push('end 1');
                resolve();
              };
            })
          : Promise.resolve().then(() => {
              events.push(`end ${String(calls)}`);
            });
      },
      () => undefined,
      timer,
    );
    autosave.changed();
    const first = autosave.flush();
    autosave.changed();
    const second = autosave.flush();
    await settle();
    finishFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('keeps work unsaved after a failure, reports it, and retries on the next demand', async () => {
    const timer = manualTimer();
    const failures: unknown[] = [];
    let attempts = 0;
    const autosave = createAutosave(
      () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve();
      },
      (error) => failures.push(error),
      timer,
    );
    autosave.changed();
    timer.fire();
    await settle();
    expect(failures).toHaveLength(1);
    await autosave.flush();
    expect(attempts).toBe(2);
  });
});
