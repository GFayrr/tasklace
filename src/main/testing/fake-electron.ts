import { EventEmitter } from 'node:events';

export interface FakeEvent {
  readonly defaultPrevented: boolean;
  readonly preventDefault: () => void;
}

/** Creates an event a handler can cancel, as Electron passes to its listeners. */
export function cancellableEvent(): FakeEvent {
  let prevented = false;
  return {
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
  };
}

/** A fake ipcMain recording the handlers and listeners registered on it, by channel. */
export class FakeIpcMain {
  readonly handlers = new Map<string, (event: unknown, ...values: unknown[]) => unknown>();
  readonly listeners = new Map<string, (event: unknown, ...values: unknown[]) => void>();

  /** Records a handler answering invocations on a channel. */
  handle(channel: string, handler: (event: unknown, ...values: unknown[]) => unknown): void {
    this.handlers.set(channel, handler);
  }

  /** Records a listener of messages on a channel. */
  on(channel: string, listener: (event: unknown, ...values: unknown[]) => void): void {
    this.listeners.set(channel, listener);
  }

  /** Invokes the handler of a channel as a page would, failing when none is registered. */
  invoke(channel: string, event: unknown, ...values: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}`);
    }
    return handler(event, ...values);
  }

  /** Sends a message on a channel as a page would, failing when nobody listens. */
  send(channel: string, event: unknown, ...values: unknown[]): void {
    const listener = this.listeners.get(channel);
    if (listener === undefined) {
      throw new Error(`No listener for ${channel}`);
    }
    listener(event, ...values);
  }
}

/** A fake page of a window, recording what the main process sends it and how often it is reloaded. */
export class FakeWebContents extends EventEmitter {
  readonly sent: string[] = [];
  reloads = 0;

  /** Records a message sent to the page. */
  send(channel: string): void {
    this.sent.push(channel);
  }

  /** Records that the page is reloaded. */
  reload(): void {
    this.reloads += 1;
  }
}

/** A fake window whose close goes through its close listeners, as Electron does, and which can be destroyed. */
export class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  closed = false;
  destroyed = false;

  /** Asks the window to close, closing it unless a close listener cancels. */
  close(): void {
    const event = cancellableEvent();
    this.emit('close', event);
    this.closed ||= !event.defaultPrevented;
  }

  /** Closes the window at once, without asking its close listeners. */
  destroy(): void {
    this.destroyed = true;
    this.closed = true;
  }

  /** Tells whether the window was destroyed. */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
