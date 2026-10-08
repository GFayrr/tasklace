import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

export type TrustCheck = (event: IpcMainEvent | IpcMainInvokeEvent) => void;

export class RefusedRequest extends Error {
  /** Marks a bridge message refused on purpose, apart from any failure while answering it. */
  constructor(reason: string) {
    super(`Request refused: ${reason}`);
    this.name = 'RefusedRequest';
  }
}

/** Returns a check that refuses any bridge message not sent by a page of the application. */
export function createTrustCheck(isTrustedAddress: (address: string) => boolean): TrustCheck {
  return (event) => {
    const address = event.senderFrame?.url ?? '';
    if (!isTrustedAddress(address)) {
      throw new RefusedRequest('it does not come from a page of the application.');
    }
  };
}

/** Refuses a bridge message whose content failed its validation. */
export function refuseMessage(): never {
  throw new RefusedRequest('its content is not valid.');
}
