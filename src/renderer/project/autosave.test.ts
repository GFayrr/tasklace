import { describe, expect, it } from 'vitest';
import { createAutosave, type Timer } from './autosave';

/** A timer driven by hand, keeping only the last callback set. */
function manualTimer(): Timer & { readonly fire: () => void; readonly pending: () => boolean } {
  let callback: (() => void) | null = null;
  return {
    set: (next) => {
      callback = next;
      return next;
    },
    clear: () => {
      callback = null;
    },
    fire: () => {
      const current = callback;
      callback = null;
      current?.();
    },
    pending: () => callback !== null,
  };
}

/** Waits for pending promise callbacks to run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createAutosave', () => {
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
