export interface Timer {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface Autosave {
  readonly changed: () => void;
  readonly flush: () => Promise<void>;
}

export const AUTOSAVE_DELAY_MS = 2_000;

const BROWSER_TIMER: Timer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => {
    clearTimeout(Number(handle));
  },
};

/** Saves a little after the last change, one save at a time, saving again for changes made during a save, keeping unsaved work marked after a failure, and saving at once on demand. */
export function createAutosave(
  save: () => Promise<void>,
  reportFailure: (error: unknown) => void,
  timer: Timer = BROWSER_TIMER,
  delayMs = AUTOSAVE_DELAY_MS,
): Autosave {
  let waiting: unknown = null;
  let unsaved = false;
  let running: Promise<void> = Promise.resolve();
  /** Saves at once what changed, without waiting for the delay. */
  const saveNow = (): Promise<void> => {
    if (waiting !== null) {
      timer.clear(waiting);
      waiting = null;
    }
    if (!unsaved) {
      return running;
    }
    unsaved = false;
    running = running.then(save, save).catch((error: unknown) => {
      unsaved = true;
      throw error;
    });
    return running;
  };
  return {
    changed: () => {
      unsaved = true;
      if (waiting !== null) {
        timer.clear(waiting);
      }
      waiting = timer.set(() => {
        saveNow().catch(reportFailure);
      }, delayMs);
    },
    flush: saveNow,
  };
}
