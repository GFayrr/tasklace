import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import type { RelayOutgoing } from '../../../core/collaboration/relay/relay-member';
import {
  drawRelayAccess,
  relayKeysOf,
  viewAccessOf,
} from '../../../core/collaboration/relay/relay-keys';
import {
  encodeRelayLink,
  hostLabelOf,
  readRelayAddress,
  readRelayLink,
  type RelayAddress,
  type RelayLink,
} from '../../../core/collaboration/relay/relay-link';
import { MESSAGE_ID_BYTES } from '../../../core/collaboration/relay/relay-wire';
import { MAX_COLLABORATION_MESSAGE_BYTES } from '../../../core/limits';
import { failure, success } from '../../../core/result';
import { isDocumentId, type DocumentId } from '../../../core/shared/shared-document';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type CollaborationEvent,
  type InvokeChannel,
  type RelayJoined,
  type RelayLinks,
  type RelayReopened,
} from '../../../preload/bridge-contract';
import type { FileTask, ResultOfTask } from '../../file-tasks';
import { handleChannel, type ChannelHandler } from '../../ipc-channels';
import { refuseMessage, type TrustCheck } from '../../ipc-trust';
import { offerSharedProject } from '../../project-files';
import { isSystemError } from '../../stored-files';
import { zlibCompressor } from '../../zlib-compressor';
import { aesGcm, systemRandomBytes } from '../aes-gcm';
import type { StartTimer } from '../secure-connection';
import {
  startRelaySession,
  type RelayEnd,
  type RelaySession,
  type RelaySessionEvent,
} from './relay-connection';
import type { RelayLinkStore } from './relay-links';

export interface RelayServices {
  readonly assertTrusted: TrustCheck;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly links: RelayLinkStore;
  readonly documentOf: (sender: WebContents) => DocumentId | null;
  readonly busyElsewhere: (sender: WebContents) => boolean;
  readonly startTimer: StartTimer;
  readonly randomBytes?: (count: number) => Uint8Array;
}

export interface RelayHandlers {
  readonly isSharing: (sender: WebContents) => boolean;
  readonly leave: (sender: WebContents) => Promise<void>;
  readonly forgetWindow: (sender: WebContents) => void;
}

type Mode = 'create' | 'join' | 'reopen';

type Outcome =
  | { readonly kind: 'in' }
  | { readonly kind: 'caughtUp'; readonly gathered: Gathered }
  | { readonly kind: 'ended'; readonly reason: RelayEnd }
  | { readonly kind: 'cancelled' };

interface Gathered {
  readonly messages: Uint8Array[];
  bytesSinceSnapshot: number;
}

interface WindowRelay {
  readonly session: RelaySession;
  readonly link: RelayLink;
  readonly outcome: Promise<Outcome>;
  readonly cancel: () => void;
  documentId: DocumentId | null;
}

const MESSAGE_KINDS: readonly unknown[] = ['update', 'snapshot'];
const ROOM_GONE: readonly RelayEnd[] = ['CLOSED', 'NO_ROOM'];

/** Answers the requests of the bridge about plans shared through a relay, one relay session per window, the main process alone holding the links and keys, and returns how to know, leave or forget what a window shares. */
export function registerRelayHandlers(services: RelayServices): RelayHandlers {
  const relays = new Map<WebContents, WindowRelay>();
  const randomBytes = services.randomBytes ?? systemRandomBytes;
  const crypto = { aead: aesGcm, compression: zlibCompressor, randomBytes };
  /** Registers the answer of a channel, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, answer);
  };
  /** Tells whether a window shares a plan already, on the network or through a relay. */
  const isBusy = (sender: WebContents): boolean =>
    relays.has(sender) || services.busyElsewhere(sender);
  /** Stops the relay session of a window, ending a request still waiting on it. */
  const stop = (sender: WebContents): WindowRelay | undefined => {
    const relay = relays.get(sender);
    relays.delete(sender);
    relay?.cancel();
    relay?.session.close();
    return relay;
  };
  /** Keeps the link of a plan on this computer, telling whether it could, a vault that does not protect it, cannot seal or a disk that fails leaving it unkept while the plan stays shared. */
  const keepLink = async (documentId: DocumentId, link: RelayLink): Promise<boolean> => {
    try {
      const kept = await services.links.keep(documentId, link);
      return kept.ok;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      console.error('The link of a shared plan could not be kept:', error);
      return false;
    }
  };
  /** Forgets the link of a plan, a failure being only logged since the plan is left either way. */
  const forgetLink = (documentId: DocumentId): Promise<void> =>
    services.links.forget(documentId).catch((error: unknown) => {
      console.error('The link of a shared plan could not be forgotten:', error);
    });
  /** Starts the relay session of a window, gathering what the relay passes on until it caught up when the window joins or reopens a plan, so that the page receives the plan in one checked state before anything after it. */
  const start = (sender: WebContents, link: RelayLink, mode: Mode): WindowRelay => {
    let gathered: Gathered | null =
      mode === 'create' ? null : { messages: [], bytesSinceSnapshot: 0 };
    let held: CollaborationEvent[] | null = null;
    const { promise: outcome, resolve: settle } = Promise.withResolvers<Outcome>();
    /** Hands the page an event, or holds it while the state a reopened plan caught up to is being checked. */
    const forward = (event: CollaborationEvent): void => {
      if (held === null) {
        tell(sender, event);
        return;
      }
      held.push(event);
    };
    /** Hands the page the events held so far, then stops holding them. */
    const release = (): void => {
      const waiting = held ?? [];
      held = null;
      waiting.forEach((event) => {
        tell(sender, event);
      });
    };
    /** Hands the page the state a reopened plan caught up to, then what came meanwhile, or ends the session for a log that is not the log of this plan. */
    const handOver = async (caughtUp: Gathered): Promise<void> => {
      const state = await stateOf(caughtUp);
      if (relays.get(sender) !== relay) {
        return;
      }
      if (state === undefined) {
        stop(sender);
        tell(sender, { kind: 'relayEnded', reason: 'MALFORMED' });
        return;
      }
      tell(sender, { kind: 'relayState', state, bytesSinceSnapshot: caughtUp.bytesSinceSnapshot });
      tell(sender, { kind: 'relayCaughtUp' });
      release();
    };
    /** Checks the log a reopened plan caught up to as the state of its plan, giving null for an empty log and undefined for a log that is not the log of this plan. */
    const stateOf = async (caughtUp: Gathered): Promise<Uint8Array | null | undefined> => {
      if (caughtUp.messages.length === 0) {
        return null;
      }
      const loaded = await services.runTask({ kind: 'readRelayLog', messages: caughtUp.messages });
      if (!loaded.ok || loaded.value.documentId !== relay.documentId) {
        console.error('The relay gave a log that is not the log of the reopened plan.');
        return undefined;
      }
      return loaded.value.state;
    };
    /** Follows what the relay session tells, gathering the log until it caught up and forwarding the rest to the page. */
    const follow = (event: RelaySessionEvent): void => {
      if (gathered !== null && event.kind === 'delivery') {
        gathered.messages.push(event.delivery.bytes);
        gathered.bytesSinceSnapshot =
          event.delivery.kind === 'snapshot'
            ? 0
            : gathered.bytesSinceSnapshot + event.delivery.compressedBytes;
        return;
      }
      if (gathered !== null && event.kind === 'caughtUp') {
        const caughtUp = gathered;
        gathered = null;
        settle({ kind: 'caughtUp', gathered: caughtUp });
        if (mode === 'reopen') {
          held = [];
          void handOver(caughtUp);
        }
        return;
      }
      if (event.kind === 'connected' && mode === 'create') {
        settle({ kind: 'in' });
      }
      if (event.kind === 'ended') {
        settle({ kind: 'ended', reason: event.reason });
        ended(event.reason);
        release();
      }
      forward(eventForPage(event));
    };
    /** Forgets a window whose session ended for good, and the link of its plan when its room is gone. */
    const ended = (reason: RelayEnd): void => {
      relays.delete(sender);
      if (ROOM_GONE.includes(reason) && relay.documentId !== null) {
        void forgetLink(relay.documentId);
      }
    };
    const session = startRelaySession({
      address: link.address,
      keys: relayKeysOf(link.access),
      creates: mode === 'create',
      keepTrying: mode === 'reopen',
      crypto,
      startTimer: services.startTimer,
      tell: follow,
    });
    const relay: WindowRelay = {
      session,
      link,
      outcome,
      cancel: () => {
        settle({ kind: 'cancelled' });
      },
      documentId: null,
    };
    relays.set(sender, relay);
    return relay;
  };
  /** Creates a room for the plan of a window with new keys, keeping its link that edits, and gives both links once in. */
  const shareInNewRoom = async (
    sender: WebContents,
    address: RelayAddress,
    documentId: DocumentId,
  ): Promise<BridgeResult<RelayLinks>> => {
    const link: RelayLink = { address, access: drawRelayAccess(randomBytes) };
    const relay = start(sender, link, 'create');
    relay.documentId = documentId;
    const outcome = await relay.outcome;
    if (outcome.kind !== 'in') {
      return refusalOf(outcome);
    }
    return success({
      editLink: encodeRelayLink(link),
      viewLink: encodeRelayLink({ address, access: viewAccessOf(link.access) }),
      kept: await keepLink(documentId, link),
    });
  };
  /** Opens in the window the plan a link joined, once the worker checked the log it caught up to, keeping the link under the plan it holds. */
  const openJoined = async (
    sender: WebContents,
    relay: WindowRelay,
    gathered: Gathered,
  ): Promise<BridgeResult<RelayJoined>> => {
    const loaded = await services.runTask({ kind: 'readRelayLog', messages: gathered.messages });
    if (relays.get(sender) !== relay) {
      return failure({ code: 'CANCELLED' });
    }
    if (!loaded.ok) {
      stop(sender);
      return loaded;
    }
    relay.documentId = loaded.value.documentId;
    return success({
      project: offerSharedProject(sender, loaded.value),
      canEdit: relay.link.access.kind === 'edit',
      relay: hostLabelOf(relay.link.address),
      bytesSinceSnapshot: gathered.bytesSinceSnapshot,
      kept: await keepLink(loaded.value.documentId, relay.link),
    });
  };
  handle(IPC_CHANNELS.shareThroughRelay, async (event, value) => {
    const address = readRelayAddress(typeof value === 'string' ? value : refuseMessage());
    if (!address.ok) {
      return failure({ code: address.error });
    }
    const documentId = services.documentOf(event.sender);
    if (documentId === null) {
      console.error('A page shared a plan through a relay without holding one.');
      return failure({ code: 'TASK_FAILED' });
    }
    if (isBusy(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    return shareInNewRoom(event.sender, address.value, documentId);
  });
  handle(IPC_CHANNELS.joinByLink, async (event, value) => {
    const link = readRelayLink(typeof value === 'string' ? value : refuseMessage());
    if (!link.ok) {
      return failure({ code: link.error });
    }
    if (isBusy(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    const relay = start(event.sender, link.value, 'join');
    const outcome = await relay.outcome;
    return outcome.kind === 'caughtUp'
      ? openJoined(event.sender, relay, outcome.gathered)
      : refusalOf(outcome);
  });
  handle(IPC_CHANNELS.reopenSharedPlan, async (event, value) => {
    const documentId = isDocumentId(value) ? value : refuseMessage();
    if (services.documentOf(event.sender) !== documentId) {
      console.error('A page reopened a shared plan it does not hold.');
      return failure({ code: 'TASK_FAILED' });
    }
    const link = await foundLink(services.links, documentId);
    if (!link.ok) {
      return link;
    }
    if (link.value === null) {
      return success(null);
    }
    if (isBusy(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    start(event.sender, link.value, 'reopen').documentId = documentId;
    return success<RelayReopened>({
      canEdit: link.value.access.kind === 'edit',
      relay: hostLabelOf(link.value.address),
    });
  });
  handle(IPC_CHANNELS.makeNewLinks, async (event) => {
    const relay = relays.get(event.sender);
    if (relay?.link.access.kind !== 'edit' || relay.documentId === null) {
      console.error(
        'A page asked for new links of a plan it does not share with the link that edits.',
      );
      return failure({ code: 'TASK_FAILED' });
    }
    if (!relay.session.closeRoom().ok) {
      return failure({ code: 'NOT_CONNECTED' });
    }
    stop(event.sender);
    return shareInNewRoom(event.sender, relay.link.address, relay.documentId);
  });
  ipcMain.on(IPC_CHANNELS.relaySend, (event: IpcMainEvent, value: unknown) => {
    services.assertTrusted(event);
    const outgoing = readRelayOutgoing(value);
    const relay = relays.get(event.sender);
    if (outgoing === null || relay === undefined) {
      console.error(
        'The page sent a message of a plan shared through a relay that cannot be sent.',
      );
      return;
    }
    const sent = relay.session.send(outgoing);
    if (!sent.ok) {
      console.warn(`A message of the shared plan could not be sent to the relay: ${sent.error}.`);
    }
  });
  return {
    isSharing: (sender) => relays.has(sender),
    leave: async (sender) => {
      const documentId = stop(sender)?.documentId ?? null;
      if (documentId !== null) {
        await forgetLink(documentId);
      }
    },
    forgetWindow: (sender) => {
      stop(sender);
    },
  };
}

/** Finds the link kept for a plan, a store the system cannot read being logged and reported. */
async function foundLink(
  links: RelayLinkStore,
  documentId: DocumentId,
): Promise<BridgeResult<RelayLink | null>> {
  try {
    return success(await links.find(documentId));
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The links of shared plans could not be read:', error);
    return failure({ code: 'READ_FAILED' });
  }
}

/** Gives the failure a request ends with when it did not get what it waited for: the refusal of the relay, or the window stopping meanwhile. */
function refusalOf(outcome: Outcome): BridgeResult<never> {
  return outcome.kind === 'ended'
    ? failure({ code: 'RELAY_ENDED', reason: outcome.reason })
    : failure({ code: 'CANCELLED' });
}

/** Turns what a relay session tells into the event the page reads. */
function eventForPage(event: RelaySessionEvent): CollaborationEvent {
  switch (event.kind) {
    case 'connected':
      return { kind: 'relayConnected', member: event.member, members: event.members };
    case 'delivery':
      return { kind: 'relayDelivery', delivery: event.delivery };
    case 'caughtUp':
      return { kind: 'relayCaughtUp' };
    case 'presence':
      return { kind: 'relayPresence', member: event.member, presence: event.presence };
    case 'joined':
      return { kind: 'relayJoined', member: event.member };
    case 'left':
      return { kind: 'relayLeft', member: event.member };
    case 'reconnecting':
    case 'offline':
      return { kind: event.kind };
    case 'ended':
      return { kind: 'relayEnded', reason: event.reason };
  }
}

/** Reads what a page sends a relay: a message of the plan with its kind, identifier, the sequence it covers and its bytes, or a presence, or null for any other shape. */
export function readRelayOutgoing(value: unknown): RelayOutgoing | null {
  /** Reads a field of a value, whatever its shape. */
  const field = (of: unknown, name: string): unknown => Reflect.get(Object(of), name);
  const kind = field(value, 'kind');
  if (kind === 'presence') {
    const bytes = field(value, 'bytes');
    return isMessageBytes(bytes) ? { kind, bytes } : null;
  }
  const message = field(value, 'message');
  const messageKind = field(message, 'kind');
  const messageId = field(message, 'messageId');
  const covers = field(message, 'covers');
  const bytes = field(message, 'bytes');
  const valid =
    kind === 'message' &&
    MESSAGE_KINDS.includes(messageKind) &&
    messageId instanceof Uint8Array &&
    messageId.length === MESSAGE_ID_BYTES &&
    Number.isSafeInteger(covers) &&
    Number(covers) >= 0 &&
    isMessageBytes(bytes);
  return valid
    ? {
        kind,
        message: {
          kind: messageKind === 'snapshot' ? 'snapshot' : 'update',
          messageId,
          covers: Number(covers),
          bytes,
        },
      }
    : null;
}

/** Tells whether a value holds the bytes of a message no larger than a message of the plan may be. */
function isMessageBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length <= MAX_COLLABORATION_MESSAGE_BYTES;
}

/** Tells a page what happened to the plan it shares through a relay, unless the page is gone. */
function tell(sender: WebContents, event: CollaborationEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.collaborationEvent, event);
  }
}
