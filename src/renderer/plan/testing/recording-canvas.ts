export interface CanvasCall {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: number;
  readonly lineDash: readonly number[];
}

interface DrawingState {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineDash: readonly number[];
}

const CHARACTER_WIDTH = 6;
const STATE_KEYS: readonly string[] = ['fillStyle', 'strokeStyle', 'lineWidth'];

/** Creates a fake 2D canvas context that records every drawing call with the colors, width and dash in force, measuring text at a fixed width per character. */
export function recordingCanvas(): {
  readonly context: CanvasRenderingContext2D;
  readonly calls: CanvasCall[];
} {
  const calls: CanvasCall[] = [];
  let state: DrawingState = { fillStyle: '', strokeStyle: '', lineWidth: 1, lineDash: [] };
  const stack: DrawingState[] = [];
  const special: Record<string, (...args: unknown[]) => unknown> = {
    save: () => {
      stack.push({ ...state });
    },
    restore: () => {
      state = stack.pop() ?? state;
    },
    setLineDash: (dash) => {
      state.lineDash = dash as readonly number[];
    },
    measureText: (text) => ({ width: String(text).length * CHARACTER_WIDTH }),
  };
  const target: Record<string | symbol, unknown> = {};
  const context = new Proxy(target, {
    get: (_target, key) => {
      if (typeof key !== 'string') {
        return undefined;
      }
      if (STATE_KEYS.includes(key)) {
        return state[key as keyof DrawingState];
      }
      if (key in target) {
        return target[key];
      }
      return (...args: unknown[]) => {
        calls.push({ name: key, args, ...state });
        return special[key]?.(...args);
      };
    },
    set: (_target, key, value: unknown) => {
      if (typeof key === 'string' && STATE_KEYS.includes(key)) {
        Object.assign(state, { [key]: value });
        return true;
      }
      target[key] = value;
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

/** Lists the recorded calls of one drawing method. */
export function callsOf(calls: readonly CanvasCall[], name: string): CanvasCall[] {
  return calls.filter((call) => call.name === name);
}
