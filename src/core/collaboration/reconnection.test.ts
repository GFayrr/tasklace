import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './reconnection';

describe('the waits between attempts to reach the host again', () => {
  it('doubles from one second and stays at thirty seconds, however many attempts were made', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 1_000, Number.MAX_SAFE_INTEGER].map(reconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });
});
