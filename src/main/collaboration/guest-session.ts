import { isOneOf } from '../../core/one-of';
import { OFFLINE_AFTER_MILLISECONDS, reconnectDelay } from '../../core/collaboration/reconnection';
import type { Introduction, JoinSecret } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import type { GuestClient, GuestEnd, GuestOptions } from './guest-client';
import type { StartTimer } from './secure-connection';

export interface GuestSessionOptions {
  readonly address: string;
  readonly port: number;
  readonly code: string;
  readonly introduction: Introduction;
  readonly startTimer: StartTimer;
  readonly connect: (options: Omit<GuestOptions, 'randomBytes'>) => GuestClient;
  readonly tell: (event: CollaborationEvent) => void;
  readonly ended: () => void;
}

export interface GuestSession {
  readonly send: GuestClient['send'];
  readonly close: () => void;
}

const FINAL_ENDS = [
  'WRONG_CODE',
  'CODE_REPLACED',
  'WRONG_KEY',
  'IDENTITY_TAKEN',
  'REMOVED',
  'NOT_PRIVATE',
  'UNSUPPORTED_VERSION',
  'MALFORMED',
  'INVALID_SHARE',
  'INVALID_INTRODUCTION',
] as const satisfies readonly GuestEnd[];

/** Keeps a window joined to a host: joins with the code, keeps the key of the plan, and comes back with it after a lost connection, waiting longer each time and telling the page, until a refusal or the page ends it. */
export function startGuestSession(options: GuestSessionOptions): GuestSession {
  let client: GuestClient | null = null;
  let planKey: Uint8Array | null = null;
  let hasOpened = false;
  let isStopped = false;
  let attempts = 0;
  let stopRetry: (() => void) | null = null;
  let stopOffline: (() => void) | null = null;
  /** Stops waiting to try again and to say that nobody answers. */
  const stopTimers = (): void => {
    stopRetry?.();
    stopOffline?.();
    stopRetry = null;
    stopOffline = null;
  };
  /** Ends the session for good, telling the page why. */
  const endForGood = (reason: GuestEnd): void => {
    isStopped = true;
    stopTimers();
    options.ended();
    options.tell({ kind: 'ended', reason });
  };
  /** Waits before trying again, telling the page the first time the connection is lost and again once nobody answered for a while. */
  const retryLater = (key: Uint8Array): void => {
    if (stopOffline === null) {
      options.tell({ kind: 'reconnecting' });
      stopOffline = options.startTimer(OFFLINE_AFTER_MILLISECONDS, () => {
        options.tell({ kind: 'offline' });
      });
    }
    stopRetry = options.startTimer(reconnectDelay(attempts), () => {
      stopRetry = null;
      attempts += 1;
      connect({ kind: 'key', key });
    });
  };
  /** Connects to the host with a secret, following what the connection tells. */
  const connect = (secret: JoinSecret): void => {
    const current = options.connect({
      address: options.address,
      port: options.port,
      secret,
      introduction: options.introduction,
      startTimer: options.startTimer,
      events: {
        opened: () => {
          hasOpened = true;
          attempts = 0;
          stopTimers();
          options.tell({ kind: 'connected' });
        },
        message: (message) => {
          options.tell({ kind: 'hostMessage', message });
        },
        planKey: (key) => {
          planKey = key;
        },
        ended: (reason) => {
          if (isStopped || current !== client) {
            return;
          }
          if (!hasOpened || planKey === null || isOneOf(FINAL_ENDS, reason)) {
            endForGood(reason);
            return;
          }
          retryLater(planKey);
        },
      },
    });
    client = current;
  };
  connect({ kind: 'code', code: options.code });
  return {
    send: (message) => (client === null ? { ok: false, error: 'NOT_OPEN' } : client.send(message)),
    close: () => {
      isStopped = true;
      stopTimers();
      client?.close();
    },
  };
}
