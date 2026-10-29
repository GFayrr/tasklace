import { bytesToHex } from '@noble/hashes/utils.js';
import { holdsChangesMissingFrom } from '../../file/tasklace-file';
import { MAX_PENDING_UPDATE_BYTES, SNAPSHOT_AFTER_BYTES } from '../../limits';
import type { TaskId } from '../../model/project';
import type { SharedRepair } from '../../shared/shared-project';
import type { SharedSession } from '../../shared/shared-session';
import { encodeMessage, readMessage, type MessageRefusal } from '../messages';
import { createMerger, type SyncRefusal } from '../sync';
import type { OpenedPresence, OpenedRelayMessage, RelayMessage } from './relay-envelope';
import { MESSAGE_ID_BYTES } from './relay-wire';

export type RelayDelivery = OpenedRelayMessage & {
  readonly settled: number;
};

export interface RelayPerson {
  readonly name: string;
  readonly selectedTaskId: TaskId | null;
  readonly canEdit: boolean;
}

export type RelayOutgoing =
  | { readonly kind: 'message'; readonly message: RelayMessage }
  | { readonly kind: 'presence'; readonly bytes: Uint8Array };

export type RelayMemberEvent =
  | { readonly kind: 'repairs'; readonly repairs: readonly SharedRepair[] }
  | { readonly kind: 'refused'; readonly reason: SyncRefusal | MessageRefusal }
  | { readonly kind: 'people'; readonly people: ReadonlyMap<number, RelayPerson> }
  | { readonly kind: 'unsharedChanges' };

export interface RelayMember {
  readonly caughtUp: () => void;
  readonly disconnected: () => void;
  readonly receive: (delivery: RelayDelivery) => void;
  readonly presence: (member: number, presence: OpenedPresence) => void;
  readonly left: (member: number) => void;
  readonly setPresence: (name: string, selectedTaskId: TaskId | null) => void;
  readonly shareWholePlan: () => void;
  readonly catchUpWith: (state: Uint8Array | null, bytesSinceSnapshot: number) => void;
  readonly stop: () => void;
}

interface RelayMemberOptions {
  readonly session: SharedSession;
  readonly canEdit: boolean;
  readonly bytesSinceSnapshot: number;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly send: (outgoing: RelayOutgoing) => void;
  readonly report: (event: RelayMemberEvent) => void;
}

const EMPTY_UPDATE = Uint8Array.of(0, 0);

interface Unconfirmed {
  readonly messageId: Uint8Array;
  readonly update: Uint8Array;
}

/** Runs a member of a plan shared through a relay, with no host: sends its changes until passed back, merges the others', follows who is in, snapshots once enough changed and, on reopening, shares or keeps apart what only this computer holds. */
export function createRelayMember(options: RelayMemberOptions): RelayMember {
  const { session, canEdit, send, report } = options;
  const merger = createMerger(session, (event) => {
    if (event.kind === 'repairs') {
      report(event);
    }
  });
  const unconfirmed = new Map<string, Unconfirmed>();
  const people = new Map<number, RelayPerson>();
  let unconfirmedBytes = 0;
  let bytesSinceSnapshot = options.bytesSinceSnapshot;
  let live = false;
  let unshared = false;
  let snapshotting = false;
  /** Sends a change of the plan to the relay. */
  const sendUpdate = ({ messageId, update }: Unconfirmed): void => {
    send({
      kind: 'message',
      message: {
        kind: 'update',
        messageId,
        covers: 0,
        bytes: encodeMessage({ kind: 'update', update }),
      },
    });
  };
  /** Keeps a change until the relay passes it back, the changes kept being replaced by the whole plan once they grow too large, and sends it while in. */
  const keep = (update: Uint8Array): void => {
    const entry = { messageId: options.randomBytes(MESSAGE_ID_BYTES), update };
    unconfirmed.set(bytesToHex(entry.messageId), entry);
    unconfirmedBytes += update.length;
    if (unconfirmedBytes > MAX_PENDING_UPDATE_BYTES) {
      unconfirmed.clear();
      const whole = {
        messageId: options.randomBytes(MESSAGE_ID_BYTES),
        update: session.encodeState(),
      };
      unconfirmed.set(bytesToHex(whole.messageId), whole);
      unconfirmedBytes = whole.update.length;
      if (live) {
        sendUpdate(whole);
      }
      return;
    }
    if (live) {
      sendUpdate(entry);
    }
  };
  /** Keeps the whole plan as the one change to send, in place of the changes kept so far, which it holds. */
  const keepWhole = (): void => {
    unconfirmed.clear();
    unconfirmedBytes = 0;
    keep(session.encodeState());
  };
  const stopUpdates = session.onUpdate((update, source) => {
    if (source === 'remote') {
      return;
    }
    if (canEdit) {
      keep(update);
    } else {
      unshared = true;
    }
  });
  /** Tells who is in now. */
  const tellPeople = (): void => {
    report({ kind: 'people', people: new Map(people) });
  };
  /** Puts the whole plan on the relay as a snapshot covering what came before it, once this member's own change made the changes since the last snapshot large enough, while no change waits for another and no snapshot of its own is on its way. */
  const snapshotIfDue = (settled: number): void => {
    if (bytesSinceSnapshot < SNAPSHOT_AFTER_BYTES || merger.isWaiting() || snapshotting) {
      return;
    }
    snapshotting = true;
    send({
      kind: 'message',
      message: {
        kind: 'snapshot',
        messageId: options.randomBytes(MESSAGE_ID_BYTES),
        covers: settled,
        bytes: encodeMessage({ kind: 'update', update: session.encodeState() }),
      },
    });
  };
  /** Takes back a change of this member that the relay passed on, telling whether it was one. */
  const confirm = (messageId: Uint8Array): boolean => {
    const key = bytesToHex(messageId);
    const entry = unconfirmed.get(key);
    if (entry === undefined) {
      return false;
    }
    unconfirmed.delete(key);
    unconfirmedBytes -= entry.update.length;
    return true;
  };
  return {
    caughtUp: () => {
      live = true;
      for (const entry of unconfirmed.values()) {
        sendUpdate(entry);
      }
      if (unshared) {
        report({ kind: 'unsharedChanges' });
      }
    },
    disconnected: () => {
      live = false;
      snapshotting = false;
      people.clear();
      tellPeople();
    },
    receive: (delivery) => {
      bytesSinceSnapshot =
        delivery.kind === 'snapshot' ? 0 : bytesSinceSnapshot + delivery.compressedBytes;
      snapshotting &&= delivery.kind !== 'snapshot';
      const read = readMessage(delivery.bytes);
      if (!read.ok) {
        report({ kind: 'refused', reason: read.error });
        return;
      }
      if (read.value.kind !== 'update') {
        report({ kind: 'refused', reason: 'UNEXPECTED_MESSAGE' });
        return;
      }
      if (confirm(delivery.messageId)) {
        if (delivery.kind === 'update') {
          snapshotIfDue(delivery.settled);
        }
        return;
      }
      const merged = merger.merge(read.value.update);
      if (!merged.ok && merged.error !== 'incompleteUpdate') {
        report({ kind: 'refused', reason: merged.error });
      }
    },
    presence: (member, presence) => {
      const read = readMessage(presence.bytes);
      if (!read.ok || read.value.kind !== 'presence') {
        report({ kind: 'refused', reason: read.ok ? 'UNEXPECTED_MESSAGE' : read.error });
        return;
      }
      people.set(member, {
        name: read.value.name,
        selectedTaskId: read.value.selectedTaskId,
        canEdit: presence.canEdit,
      });
      tellPeople();
    },
    left: (member) => {
      if (people.delete(member)) {
        tellPeople();
      }
    },
    setPresence: (name, selectedTaskId) => {
      if (live) {
        send({
          kind: 'presence',
          bytes: encodeMessage({ kind: 'presence', name, selectedTaskId }),
        });
      }
    },
    shareWholePlan: () => {
      if (canEdit) {
        keepWhole();
      }
    },
    catchUpWith: (state, bytes) => {
      bytesSinceSnapshot = bytes;
      const merged = state === null ? null : merger.merge(state);
      const refusal =
        merged === null || merged.ok || merged.error === 'incompleteUpdate' ? null : merged.error;
      if (refusal !== null) {
        report({ kind: 'refused', reason: refusal });
        unshared = true;
        return;
      }
      if (!holdsChangesMissingFrom(session.encodeState(), state ?? EMPTY_UPDATE)) {
        return;
      }
      if (canEdit) {
        keepWhole();
      } else {
        unshared = true;
      }
    },
    stop: stopUpdates,
  };
}
