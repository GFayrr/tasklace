import type { RelayFrame } from '../../src/core/collaboration/relay/relay-wire.ts';

export interface SendQueue {
  readonly push: (frame: RelayFrame) => boolean;
  readonly pushPresence: (from: number, bytes: Uint8Array) => boolean;
  readonly next: () => RelayFrame | undefined;
  readonly isEmpty: () => boolean;
  readonly clear: () => void;
}

const FRAME_OVERHEAD_BYTES = 64;
const NO_BYTES = new Uint8Array();

/** Makes the queue of what waits for one member of a room, counting what each frame holds so that a member too slow can be told apart, and keeping only the newest presence of each other member. */
export function createSendQueue(maxQueuedBytes: number): SendQueue {
  const frames: RelayFrame[] = [];
  const presences = new Map<number, Uint8Array>();
  let queuedBytes = 0;
  /** Adds a frame, telling whether what waits still fits. */
  const push = (frame: RelayFrame): boolean => {
    frames.push(frame);
    queuedBytes += sizeOf(frame);
    return queuedBytes <= maxQueuedBytes;
  };
  return {
    push,
    pushPresence: (from, bytes) => {
      const waiting = presences.has(from);
      presences.set(from, bytes);
      return waiting || push({ type: 'presence', member: from, bytes: NO_BYTES });
    },
    next: () => {
      const frame = frames.shift();
      if (frame === undefined) {
        return undefined;
      }
      queuedBytes -= sizeOf(frame);
      return frame.type === 'presence' ? withNewestPresence(presences, frame) : frame;
    },
    isEmpty: () => frames.length === 0,
    clear: () => {
      frames.length = 0;
      presences.clear();
      queuedBytes = 0;
    },
  };
}

/** Gives the bytes a waiting frame is counted for: what any frame costs, plus its record when it has one, a presence being kept apart as at most one per member waits. */
function sizeOf(frame: RelayFrame): number {
  return FRAME_OVERHEAD_BYTES + (frame.type === 'record' ? frame.record.length : 0);
}

/** Gives a presence about to leave with the newest bytes its member sent, which then no longer wait. */
function withNewestPresence(
  presences: Map<number, Uint8Array>,
  frame: Extract<RelayFrame, { readonly type: 'presence' }>,
): RelayFrame {
  const bytes = presences.get(frame.member) ?? NO_BYTES;
  presences.delete(frame.member);
  return { ...frame, bytes };
}
