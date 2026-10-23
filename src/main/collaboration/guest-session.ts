import { isOneOf } from '../../core/one-of';
import { OFFLINE_AFTER_MILLISECONDS, reconnectDelay } from '../../core/collaboration/reconnection';
import type { Introduction, JoinSecret } from '../../core/collaboration/secure/link';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import type { GuestClient, GuestEnd, GuestOptions } from './guest-client';
import type { StartTimer } from './secure-connection';

export interface GuestSessionOptions {
  readonly address: string;
  readonly port: number;
  readonly secret: JoinSecret;
  readonly introduction: Introduction;
  readonly startTimer: StartTimer;
  readonly connect: (options: Omit<GuestOptions, 'randomBytes'>) => GuestClient;
  readonly tell: (event: CollaborationEvent) => void;
  readonly ended: () => void;
  readonly identity?: (host: Introduction | null) => void;
}

export interface GuestSession {
  readonly send: GuestClient['send'];
  readonly planKey: () => Uint8Array | null;
  readonly askIdentity: () => void;
  readonly close: () => void;
}

const FINAL_ENDS = [
  'WRONG_CODE',
  'CODE_REPLACED',
  'WRONG_KEY',
  'IDENTITY_TAKEN',
  'TURNED_AWAY',
  'NOT_PRIVATE',
  'UNSUPPORTED_VERSION',
  'MALFORMED',
  'INVALID_SHARE',
  'INVALID_INTRODUCTION',
] as const satisfies readonly GuestEnd[];

/** Keeps a window joined to a host: joins with the code or the key, keeps the key of the plan, comes back with it after a lost connection, waiting longer each time and telling the page, until a refusal, the host leaving or the page ends it. */
export function startGuestSession(options: GuestSessionOptions): GuestSession {
  let client: GuestClient | null = null;
  let planKey: Uint8Array | null = options.secret.kind === 'key' ? options.secret.key : null;
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
  /** Ends the session for good, telling the page why before the window forgets it. */
  const endForGood = (reason: GuestEnd): void => {
    isStopped = true;
    stopTimers();
    options.tell({ kind: 'ended', reason });
    options.ended();
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
  /** Stops trying the host that left and tells the page, which then looks for the next host. */
  const hostLeft = (): void => {
    isStopped = true;
    stopTimers();
    options.tell({ kind: 'hostLeft' });
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
        identity: (host) => {
          options.identity?.(host);
        },
        ended: (reason) => {
          if (isStopped || current !== client) {
            return;
          }
          const joinedOnce = hasOpened || options.secret.kind === 'key';
          if (!joinedOnce || planKey === null || isOneOf(FINAL_ENDS, reason)) {
            endForGood(reason);
            return;
          }
          if (reason === 'HOST_LEFT') {
            hostLeft();
            return;
          }
          retryLater(planKey);
        },
      },
    });
    client = current;
  };
  connect(options.secret);
  return {
    send: (message) => (client === null ? { ok: false, error: 'NOT_OPEN' } : client.send(message)),
    planKey: () => planKey,
    askIdentity: () => {
      client?.askIdentity();
    },
    close: () => {
      isStopped = true;
      stopTimers();
      client?.close();
    },
  };
}
