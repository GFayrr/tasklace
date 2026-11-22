import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import { settle } from '../app/testing/fake-app-context';
import { ANNOUNCED_EVENT_BYTES, bytesOf, createPacedEvents } from './paced-events';

/** Returns a message of a guest carrying a given number of bytes, numbered by its first byte. */
function message(number: number, size: number): CollaborationEvent {
  const bytes = new Uint8Array(Math.max(size, 1));
  bytes[0] = number;
  return { kind: 'peerMessage', peer: 1, message: bytes };
}

/** Returns a paced delivery with the number of each event handled and what the page was told, the test releasing the paints. */
function pacedRecord() {
  const handled: number[] = [];
  const told: string[] = [];
  const paints: (() => void)[] = [];
  const deliver = createPacedEvents({
    handle: (event) => {
      if (event.kind === 'peerMessage') {
        handled.push(event.message[0] ?? -1);
        told.push(`handled ${String(event.message[0])}`);
      }
    },
    announce: (waiting) => {
      told.push(waiting ? 'waiting' : 'done');
    },
    waitForPaint: () =>
      new Promise((resolve) => {
        told.push('paint asked');
        paints.push(resolve);
      }),
  });
  /** Lets the page paint once, as the browser would. */
  const paint = async (): Promise<void> => {
    paints.shift()?.();
    await settle();
  };
  return { deliver, handled, told, paint };
}

describe('createPacedEvents', () => {
  it('hands small events over at once, without telling the page anything', () => {
    const { deliver, handled, told } = pacedRecord();
    deliver(message(1, ANNOUNCED_EVENT_BYTES - 1));
    deliver({ kind: 'connected' });
    expect(handled).toEqual([1]);
    expect(told).toEqual(['handled 1']);
  });

  it('tells the page it waits and lets it paint before a large event, the events coming meanwhile waiting behind it', async () => {
    const { deliver, told, paint } = pacedRecord();
    deliver(message(1, ANNOUNCED_EVENT_BYTES));
    deliver(message(2, 1));
    await settle();
    expect(told).toEqual(['waiting', 'paint asked']);
    await paint();
    expect(told).toEqual(['waiting', 'paint asked', 'handled 1', 'handled 2', 'done']);
    deliver(message(3, 1));
    expect(told.at(-1)).toBe('handled 3');
  });

  it('hands every event over in the order it came, large ones included', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 12 }), async (large) => {
        const { deliver, handled, paint } = pacedRecord();
        large.forEach((isLarge, index) => {
          deliver(message(index, isLarge ? ANNOUNCED_EVENT_BYTES : 1));
        });
        for (const isLarge of large) {
          if (isLarge) {
            await paint();
          }
        }
        expect(handled).toEqual(large.map((_, index) => index));
      }),
    );
  });

  it('keeps handling the events behind one whose handling throws, raising the exception apart', async () => {
    vi.useFakeTimers();
    try {
      const handled: string[] = [];
      const deliver = createPacedEvents({
        handle: (event) => {
          handled.push(event.kind);
          if (event.kind === 'relayCaughtUp') {
            throw new Error('Broken handler');
          }
        },
        announce: () => undefined,
        waitForPaint: () => Promise.resolve(),
      });
      deliver(message(1, ANNOUNCED_EVENT_BYTES));
      deliver({ kind: 'relayCaughtUp' });
      deliver({ kind: 'connected' });
      await expect(vi.advanceTimersByTimeAsync(0)).rejects.toThrow('Broken handler');
      expect(handled).toEqual(['peerMessage', 'relayCaughtUp', 'connected']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('handles a large event and the ones behind it even when the page cannot wait to paint, logging why', async () => {
    const handled: string[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deliver = createPacedEvents({
        handle: (event) => handled.push(event.kind),
        announce: () => undefined,
        waitForPaint: () => Promise.reject(new Error('No frame')),
      });
      deliver(message(1, ANNOUNCED_EVENT_BYTES));
      deliver({ kind: 'connected' });
      await settle();
      deliver({ kind: 'relayCaughtUp' });
      expect(handled).toEqual(['peerMessage', 'connected', 'relayCaughtUp']);
      expect(logged.mock.calls).toEqual([
        ['The page could not paint before handling a large change:', new Error('No frame')],
      ]);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('bytesOf', () => {
  it('counts the bytes of the plan an event carries, and none for the others', () => {
    const bytes = new Uint8Array(5);
    expect([
      bytesOf({ kind: 'peerMessage', peer: 1, message: bytes }),
      bytesOf({ kind: 'hostMessage', message: bytes }),
      bytesOf({
        kind: 'relayDelivery',
        delivery: {
          kind: 'update',
          messageId: new Uint8Array(16),
          covers: 0,
          bytes,
          compressedBytes: 5,
          settled: 1,
        },
      }),
      bytesOf({ kind: 'relayState', state: bytes, bytesSinceSnapshot: 0 }),
      bytesOf({ kind: 'relayState', state: null, bytesSinceSnapshot: 0 }),
      bytesOf({ kind: 'connected' }),
    ]).toEqual([5, 5, 5, 5, 0, 0]);
  });
});
