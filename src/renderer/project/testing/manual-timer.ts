import type { Timer } from '../autosave';

/** Creates a timer driven by hand, keeping only the last callback set. */
export function manualTimer(): Timer & {
  readonly fire: () => void;
  readonly pending: () => boolean;
} {
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
