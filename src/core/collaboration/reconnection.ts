export const FIRST_RECONNECT_MILLISECONDS = 1_000;
export const MAX_RECONNECT_MILLISECONDS = 30_000;
export const OFFLINE_AFTER_MILLISECONDS = 15_000;

const GROWTH = 2;

/** Gives how long to wait before a numbered attempt to reach the host again, doubling from one second up to thirty. */
export function reconnectDelay(attempt: number): number {
  const exponent = Math.min(attempt, Math.ceil(Math.log2(MAX_RECONNECT_MILLISECONDS)));
  return Math.min(FIRST_RECONNECT_MILLISECONDS * GROWTH ** exponent, MAX_RECONNECT_MILLISECONDS);
}
