import * as Y from 'yjs';
import { MAX_PENDING_UPDATE_BYTES } from '../limits';
import type { TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import type { MergeFailure, SharedRepair } from '../shared/shared-project';
import type { SharedSession } from '../shared/shared-session';
import type { CollaborationMessage } from './messages';
import type { Endpoint, Participant, ParticipantId } from './participants';
import {
  joinRoster,
  leaveRoster,
  mayEdit,
  setRight,
  startRoster,
  updatePresence,
  type Roster,
  type RosterRefusal,
} from './roster';

export type SyncRefusal =
  | 'READ_ONLY'
  | 'UNKNOWN_PARTICIPANT'
  | 'UNEXPECTED_MESSAGE'
  | 'INVALID_STATE_VECTOR'
  | 'PENDING_TOO_LARGE'
  | MergeFailure['kind'];

export type SyncEvent =
  | { readonly kind: 'repairs'; readonly repairs: readonly SharedRepair[] }
  | { readonly kind: 'refused'; readonly from: ParticipantId | null; readonly reason: SyncRefusal }
  | {
      readonly kind: 'roster';
      readonly you: ParticipantId;
      readonly participants: readonly Participant[];
    }
  | { readonly kind: 'unsharedChanges' };

export interface Outgoing {
  readonly to: ParticipantId;
  readonly message: CollaborationMessage;
}

export interface Host {
  readonly roster: () => Roster;
  readonly connect: (
    peer: ParticipantId,
    name: string,
    endpoint: Endpoint | null,
    tokenDigest: string | null,
  ) => Result<null, RosterRefusal>;
  readonly disconnect: (peer: ParticipantId) => void;
  readonly receive: (from: ParticipantId, message: CollaborationMessage) => void;
  readonly setRight: (peer: ParticipantId, canEdit: boolean) => Result<null, RosterRefusal>;
  readonly setPresence: (name: string, selectedTaskId: TaskId | null) => void;
  readonly stop: () => void;
}

export interface Guest {
  readonly connected: () => void;
  readonly disconnected: () => void;
  readonly receive: (message: CollaborationMessage) => void;
  readonly setPresence: (name: string, selectedTaskId: TaskId | null) => void;
  readonly stop: () => void;
}

interface HostOptions {
  readonly session: SharedSession;
  readonly hostId: ParticipantId;
  readonly name: string;
  readonly tokenDigest: string | null;
  readonly roster: Roster | null;
  readonly send: (outgoing: Outgoing) => void;
  readonly report: (event: SyncEvent) => void;
  readonly shareLater?: (share: () => void) => void;
  readonly broadcast?: (to: readonly ParticipantId[], message: CollaborationMessage) => void;
}

interface GuestOptions {
  readonly session: SharedSession;
  readonly send: (message: CollaborationMessage) => void;
  readonly report: (event: SyncEvent) => void;
}

interface Merger {
  readonly merge: (update: Uint8Array) => Result<null, SyncRefusal | 'incompleteUpdate'>;
  readonly forget: () => void;
}

/** Runs the host of a shared plan, from a new list or the one taken over from a host that left: it keeps the list of participants, sends each one what it lacks, merges the changes of those who may edit and passes every change to everyone. */
export function createHost(options: HostOptions): Host {
  const { session, hostId, send, report } = options;
  let roster = options.roster ?? startRoster(hostId, options.name, options.tokenDigest);
  const mergers = new Map<ParticipantId, Merger>();
  /** Sends a message to every participant but the host, at once when the transport can send one message to many. */
  const toEveryone = (message: CollaborationMessage): void => {
    const others = roster.participants.filter(({ id }) => id !== hostId).map(({ id }) => id);
    if (options.broadcast !== undefined) {
      options.broadcast(others, message);
      return;
    }
    for (const to of others) {
      send({ to, message });
    }
  };
  let presenceQueued = false;
  /** Sends every participant the list of participants, each told which one it is. */
  const shareRoster = (): void => {
    presenceQueued = false;
    for (const participant of roster.participants) {
      if (participant.id !== hostId) {
        send({
          to: participant.id,
          message: { kind: 'participants', you: participant.id, participants: roster.participants },
        });
      }
    }
    report({ kind: 'roster', you: hostId, participants: roster.participants });
  };
  /** Shares the list once for all the presences of a moment, so that a participant sending many cannot make the host send the list to everyone each time. */
  const sharePresence = (): void => {
    if (options.shareLater === undefined) {
      shareRoster();
      return;
    }
    if (presenceQueued) {
      return;
    }
    presenceQueued = true;
    options.shareLater(() => {
      if (presenceQueued) {
        shareRoster();
      }
    });
  };
  const stopUpdates = session.onUpdate((update) => {
    toEveryone({ kind: 'update', update });
  });
  /** Tells a participant the host refused its change, so that it keeps its version apart and takes the plan of the host again. */
  const refuse = (from: ParticipantId, reason: SyncRefusal): void => {
    report({ kind: 'refused', from, reason });
    send({ to: from, message: { kind: 'refused' } });
  };
  /** Merges a change a participant sent, keeping an incomplete one with the next and asking it for what is missing. */
  const mergeFrom = (from: ParticipantId, merger: Merger, update: Uint8Array): void => {
    const merged = merger.merge(update);
    if (!merged.ok && merged.error === 'incompleteUpdate') {
      send({ to: from, message: { kind: 'stateVector', vector: session.encodeStateVector() } });
    } else if (!merged.ok) {
      refuse(from, merged.error);
    }
  };
  return {
    roster: () => roster,
    connect: (peer, name, endpoint, tokenDigest) => {
      const joined = joinRoster(roster, peer, name, endpoint, tokenDigest);
      if (!joined.ok) {
        return joined;
      }
      roster = joined.value;
      mergers.set(peer, createMerger(session, report));
      shareRoster();
      return success(null);
    },
    disconnect: (peer) => {
      roster = leaveRoster(roster, peer);
      mergers.delete(peer);
      shareRoster();
    },
    receive: (from, message) => {
      const merger = mergers.get(from);
      if (merger === undefined) {
        report({ kind: 'refused', from, reason: 'UNKNOWN_PARTICIPANT' });
        return;
      }
      receiveAtHost(message, {
        stateVector: (vector) => {
          answerStateVector(
            session,
            vector,
            (reply) => {
              send({ to: from, message: reply });
            },
            (reason) => {
              report({ kind: 'refused', from, reason });
            },
          );
        },
        update: (update) => {
          if (mayEdit(roster, from)) {
            mergeFrom(from, merger, update);
          } else {
            refuse(from, 'READ_ONLY');
          }
        },
        presence: (name, selectedTaskId) => {
          roster = updatePresence(roster, from, { name, selectedTaskId });
          sharePresence();
        },
        unexpected: () => {
          report({ kind: 'refused', from, reason: 'UNEXPECTED_MESSAGE' });
        },
      });
    },
    setRight: (peer, canEdit) => {
      const changed = setRight(roster, peer, canEdit);
      if (!changed.ok) {
        return changed;
      }
      roster = changed.value;
      shareRoster();
      return success(null);
    },
    setPresence: (name, selectedTaskId) => {
      roster = updatePresence(roster, hostId, { name, selectedTaskId });
      sharePresence();
    },
    stop: () => {
      presenceQueued = false;
      stopUpdates();
    },
  };
}

interface HostHandlers {
  readonly stateVector: (vector: Uint8Array) => void;
  readonly update: (update: Uint8Array) => void;
  readonly presence: (name: string, selectedTaskId: TaskId | null) => void;
  readonly unexpected: () => void;
}

/** Hands a message received by the host to the handler of its kind, a list of participants or a refusal being unexpected since only the host sends one. */
function receiveAtHost(message: CollaborationMessage, handlers: HostHandlers): void {
  switch (message.kind) {
    case 'stateVector':
      handlers.stateVector(message.vector);
      return;
    case 'update':
      handlers.update(message.update);
      return;
    case 'presence':
      handlers.presence(message.name, message.selectedTaskId);
      return;
    case 'participants':
    case 'refused':
      handlers.unexpected();
  }
}

/** Answers the state vector of the other side with what it lacks, then with the own state vector so that it can send back what this side lacks, refusing a vector that cannot be read. */
function answerStateVector(
  session: SharedSession,
  vector: Uint8Array,
  reply: (message: CollaborationMessage) => void,
  refuse: (reason: SyncRefusal) => void,
): void {
  const missing = encodeMissing(session, vector);
  if (!missing.ok) {
    refuse(missing.error);
    return;
  }
  reply({ kind: 'update', update: missing.value });
  reply({ kind: 'stateVector', vector: session.encodeStateVector() });
}

/** Encodes what a copy lacks given its state vector, or refuses a vector Yjs cannot read. */
function encodeMissing(
  session: SharedSession,
  vector: Uint8Array,
): Result<Uint8Array, 'INVALID_STATE_VECTOR'> {
  try {
    Y.decodeStateVector(vector);
    return success(session.encodeState(vector));
  } catch (error) {
    if (error instanceof Error) {
      return failure('INVALID_STATE_VECTOR');
    }
    throw error;
  }
}

/** Creates the merger of the updates of one sender, which keeps an update that depends on missing ones with the following, within a size, reporting the repairs a merge needed. */
function createMerger(session: SharedSession, report: (event: SyncEvent) => void): Merger {
  let pending: Uint8Array | null = null;
  return {
    merge: (update) => {
      const combined = combinedWith(pending, update);
      if (combined === null) {
        pending = null;
        return failure('malformedUpdate');
      }
      const merged = session.merge(combined);
      if (merged.ok) {
        pending = null;
        if (merged.value.length > 0) {
          report({ kind: 'repairs', repairs: merged.value });
        }
        return success(null);
      }
      if (merged.error.kind !== 'incompleteUpdate') {
        pending = null;
        return failure(merged.error.kind);
      }
      if (combined.length > MAX_PENDING_UPDATE_BYTES) {
        pending = null;
        return failure('PENDING_TOO_LARGE');
      }
      pending = combined;
      return failure('incompleteUpdate');
    },
    forget: () => {
      pending = null;
    },
  };
}

/** Joins an update to the one kept back, or returns null when Yjs cannot read them together. */
function combinedWith(pending: Uint8Array | null, update: Uint8Array): Uint8Array | null {
  if (pending === null) {
    return update;
  }
  try {
    return Y.mergeUpdates([pending, update]);
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

/** Runs a participant of a shared plan: it sends its own changes while it may edit, merges what the host sends, follows the list of participants, and tells when it changed the plan while it could not share the change. */
export function createGuest(options: GuestOptions): Guest {
  const { session, send, report } = options;
  const merger = createMerger(session, report);
  let canEdit = false;
  let isConnected = false;
  let unshared = false;
  const stopUpdates = session.onUpdate((update, source) => {
    if (source === 'remote') {
      return;
    }
    if (canEdit && isConnected) {
      send({ kind: 'update', update });
    } else {
      unshared = true;
    }
  });
  /** Merges what the host sent, asking it again for what is missing when the update depends on changes not received, and, when it cannot be merged, telling that this copy no longer follows the plan of the host. */
  const mergeFromHost = (update: Uint8Array): void => {
    const merged = merger.merge(update);
    if (!merged.ok && merged.error === 'incompleteUpdate') {
      send({ kind: 'stateVector', vector: session.encodeStateVector() });
    } else if (!merged.ok) {
      report({ kind: 'refused', from: null, reason: merged.error });
      report({ kind: 'unsharedChanges' });
    }
  };
  /** Sends the host what it lacks while this participant may edit, or tells that changes made while unable to share stay here. */
  const answerHost = (vector: Uint8Array): void => {
    if (!canEdit) {
      if (unshared) {
        report({ kind: 'unsharedChanges' });
      }
      return;
    }
    const missing = encodeMissing(session, vector);
    if (missing.ok) {
      send({ kind: 'update', update: missing.value });
      unshared = false;
    } else {
      report({ kind: 'refused', from: null, reason: missing.error });
    }
  };
  return {
    connected: () => {
      isConnected = true;
      merger.forget();
      send({ kind: 'stateVector', vector: session.encodeStateVector() });
    },
    disconnected: () => {
      isConnected = false;
    },
    receive: (message) => {
      switch (message.kind) {
        case 'update':
          mergeFromHost(message.update);
          return;
        case 'stateVector':
          answerHost(message.vector);
          return;
        case 'participants':
          canEdit = message.participants.some(
            (participant) => participant.id === message.you && participant.canEdit,
          );
          report({ kind: 'roster', you: message.you, participants: message.participants });
          return;
        case 'refused':
          report({ kind: 'unsharedChanges' });
          return;
        case 'presence':
          report({ kind: 'refused', from: null, reason: 'UNEXPECTED_MESSAGE' });
      }
    },
    setPresence: (name, selectedTaskId) => {
      if (isConnected) {
        send({ kind: 'presence', name, selectedTaskId });
      }
    },
    stop: stopUpdates,
  };
}
