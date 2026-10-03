import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import { createTrustCheck, RefusedRequest, refuseMessage } from './ipc-trust';

/** Builds an event sent from a page at an address, or from no page at all. */
function eventFrom(address: string | null): IpcMainInvokeEvent {
  const senderFrame = address === null ? null : { url: address };
  return { senderFrame } as unknown as IpcMainInvokeEvent;
}

describe('createTrustCheck', () => {
  const check = createTrustCheck((address) => address.startsWith('app://tasklace/'));

  it('accepts a message from a page of the application', () => {
    expect(() => {
      check(eventFrom('app://tasklace/index.html'));
    }).not.toThrow();
  });

  it.each(['https://example.com/', ''])('refuses a message from %j', (address) => {
    expect(() => {
      check(eventFrom(address));
    }).toThrow(RefusedRequest);
  });

  it('refuses a message whose page is gone', () => {
    expect(() => {
      check(eventFrom(null));
    }).toThrow('Request refused: it does not come from a page of the application.');
  });
});

describe('refuseMessage', () => {
  it('refuses a message with a refusal told apart from other failures', () => {
    expect(() => refuseMessage()).toThrow(RefusedRequest);
    expect(() => refuseMessage()).toThrow('Request refused: its content is not valid.');
    expect(new RefusedRequest('x').name).toBe('RefusedRequest');
  });
});
