import { describe, expect, it } from 'vitest';
import { createSendQueue } from './send-queue.ts';

const FRAME_OVERHEAD_BYTES = 64;

/** Takes every frame waiting in a queue, in order. */
function drained(queue: ReturnType<typeof createSendQueue>) {
  const frames = [];
  for (let frame = queue.next(); frame !== undefined; frame = queue.next()) {
    frames.push(frame);
  }
  return frames;
}

describe('what waits for a member of a room', () => {
  it('gives the frames in the order they came', () => {
    const queue = createSendQueue(1_024);
    queue.push({ type: 'joined', member: 2 });
    queue.push({ type: 'record', seq: 1, record: Uint8Array.of(1) });
    queue.push({ type: 'caughtUp' });
    expect([drained(queue), queue.isEmpty()]).toEqual([
      [
        { type: 'joined', member: 2 },
        { type: 'record', seq: 1, record: Uint8Array.of(1) },
        { type: 'caughtUp' },
      ],
      true,
    ]);
  });

  it('keeps only the newest presence of each member, in the place of its first, however many it sends meanwhile', () => {
    const queue = createSendQueue(1_024);
    const fits = [
      queue.pushPresence(2, Uint8Array.of(1)),
      queue.push({ type: 'joined', member: 3 }),
      queue.pushPresence(3, Uint8Array.of(7)),
      ...Array.from({ length: 50 }, (_unused, index) =>
        queue.pushPresence(2, Uint8Array.of(index + 2)),
      ),
    ];
    expect([fits.every(Boolean), drained(queue)]).toEqual([
      true,
      [
        { type: 'presence', member: 2, bytes: Uint8Array.of(51) },
        { type: 'joined', member: 3 },
        { type: 'presence', member: 3, bytes: Uint8Array.of(7) },
      ],
    ]);
  });

  it('counts what every frame costs, and the bytes of a record, telling once more waits than a member may have', () => {
    const queue = createSendQueue(2 * FRAME_OVERHEAD_BYTES + 3);
    const fits = [
      queue.push({ type: 'caughtUp' }),
      queue.push({ type: 'record', seq: 1, record: Uint8Array.of(1, 2, 3) }),
      queue.push({ type: 'left', member: 2 }),
    ];
    queue.next();
    queue.next();
    expect([fits, queue.push({ type: 'closed' })]).toEqual([[true, true, false], true]);
  });

  it('forgets everything waiting once cleared', () => {
    const queue = createSendQueue(1_024);
    queue.push({ type: 'caughtUp' });
    queue.pushPresence(2, Uint8Array.of(1));
    queue.clear();
    const afterwards = queue.pushPresence(2, Uint8Array.of(2));
    expect([afterwards, drained(queue)]).toEqual([
      true,
      [{ type: 'presence', member: 2, bytes: Uint8Array.of(2) }],
    ]);
  });
});
