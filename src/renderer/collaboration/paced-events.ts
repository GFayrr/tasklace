import type { CollaborationEvent } from '../../preload/bridge-contract';

export const ANNOUNCED_EVENT_BYTES = 262_144;

export interface PacedEventsOptions {
  readonly handle: (event: CollaborationEvent) => void;
  readonly announce: (waiting: boolean) => void;
  readonly waitForPaint: () => Promise<void>;
}

/** Hands collaboration events to a handler in the order they come, at once for most, but after announcing the wait and letting the page paint it for an event carrying enough bytes to keep the page busy, the events coming meanwhile waiting behind it. */
export function createPacedEvents(
  options: PacedEventsOptions,
): (event: CollaborationEvent) => void {
  const queue: CollaborationEvent[] = [];
  let draining = false;
  /** Handles the waiting events in order, announcing the wait before each large one, then says the wait is over. */
  const drain = async (): Promise<void> => {
    draining = true;
    for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
      if (bytesOf(event) >= ANNOUNCED_EVENT_BYTES) {
        options.announce(true);
        await options.waitForPaint();
      }
      handleApart(options.handle, event);
    }
    draining = false;
    options.announce(false);
  };
  return (event) => {
    if (!draining && bytesOf(event) < ANNOUNCED_EVENT_BYTES) {
      options.handle(event);
      return;
    }
    queue.push(event);
    if (!draining) {
      void drain();
    }
  };
}

/** Handles an event, an exception being raised again on its own so that the page reports it while the events behind it are still handled. */
function handleApart(handle: (event: CollaborationEvent) => void, event: CollaborationEvent): void {
  try {
    handle(event);
  } catch (error) {
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

/** Returns how many bytes of the plan an event carries, none for an event about the connection or the people. */
export function bytesOf(event: CollaborationEvent): number {
  switch (event.kind) {
    case 'peerMessage':
    case 'hostMessage':
      return event.message.length;
    case 'relayDelivery':
      return event.delivery.bytes.length;
    case 'relayState':
      return event.state?.length ?? 0;
    default:
      return 0;
  }
}
