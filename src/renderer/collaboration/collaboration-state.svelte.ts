import { SvelteMap } from 'svelte/reactivity';
import {
  encodeMessage,
  readMessage,
  type CollaborationMessage,
} from '../../core/collaboration/messages';
import {
  isParticipantId,
  requireParticipantId,
  type Participant,
  type ParticipantId,
} from '../../core/collaboration/participants';
import {
  createGuest,
  createHost,
  type Guest,
  type Host,
  type SyncEvent,
} from '../../core/collaboration/sync';
import type { TaskId } from '../../core/model/project';
import type { Result } from '../../core/result';
import type { SharedRepair } from '../../core/shared/shared-project';
import type { SharedSession } from '../../core/shared/shared-session';
import type {
  BridgeResult,
  CollaborationEvent,
  CollaborationSettings,
  FileFailure,
  GuestEndReason,
  NearbyPlan,
  Sharing,
  TasklaceBridge,
} from '../../preload/bridge-contract';

export type CollaborationBridge = Pick<
  TasklaceBridge,
  | 'collaborationSettings'
  | 'saveCollaborationSettings'
  | 'sharePlan'
  | 'stopCollaboration'
  | 'joinPlan'
  | 'findPlans'
  | 'dropPeer'
  | 'copyJoinCode'
  | 'sendToCollaboration'
  | 'onCollaborationEvent'
>;

export interface CollaborationContext {
  readonly bridge: CollaborationBridge;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly session: () => SharedSession | null;
  readonly openShared: (state: Uint8Array) => Promise<boolean>;
  readonly repaired: (repairs: readonly SharedRepair[]) => void;
  readonly selectedTaskId: () => TaskId | null;
}

export type CollaborationMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hosting'; readonly sharing: Sharing }
  | { readonly kind: 'joining' }
  | { readonly kind: 'guest'; readonly connected: boolean };

export type CollaborationFailure = FileFailure | { readonly code: 'NO_NAME' | 'NO_PROJECT' };

export const EMPTY_STATE_VECTOR = Uint8Array.of(0);

interface Hosting {
  readonly host: Host;
  readonly peers: Map<number, ParticipantId>;
  readonly participantsByPeer: Map<ParticipantId, number>;
  readonly joinedAt: Map<ParticipantId, Date>;
}

/** Holds what the page shares or joined: the mode, the people in the plan and the plans nearby, linking the host or guest of the shared plan to the open session and the messages the main process carries, so that the interface only reads it and calls its actions. */
export class CollaborationState {
  #mode = $state.raw<CollaborationMode>({ kind: 'idle' });
  #participants = $state.raw<readonly Participant[]>([]);
  #me = $state.raw<ParticipantId | null>(null);
  #settings = $state.raw<CollaborationSettings | null>(null);
  #nearby = $state.raw<readonly NearbyPlan[]>([]);
  #lastEnd = $state.raw<GuestEndReason | null>(null);
  readonly #presence = $derived.by(() => presenceOf(this.#participants, this.#me));
  readonly #context: CollaborationContext;
  #hosting: Hosting | null = null;
  #guest: Guest | null = null;
  #waitingRoster: CollaborationMessage | null = null;
  #openingShared = false;
  #presenceQueued = false;

  /** Starts following the events of the main process about the shared plan. */
  constructor(context: CollaborationContext) {
    this.#context = context;
    context.bridge.onCollaborationEvent((event) => {
      this.#receive(event);
    });
  }

  /** Returns what the page shares or joined. */
  get mode(): CollaborationMode {
    return this.#mode;
  }

  /** Returns the people in the shared plan, the host first, or none outside a shared plan. */
  get participants(): readonly Participant[] {
    return this.#participants;
  }

  /** Returns the participant this page is, or null outside a shared plan. */
  get me(): ParticipantId | null {
    return this.#me;
  }

  /** Returns the settings of this computer once read, or null. */
  get settings(): CollaborationSettings | null {
    return this.#settings;
  }

  /** Returns the shared plans found nearby while searching. */
  get nearbyPlans(): readonly NearbyPlan[] {
    return this.#nearby;
  }

  /** Returns why the latest connection to a host ended, or null. */
  get lastEnd(): GuestEndReason | null {
    return this.#lastEnd;
  }

  /** Returns when a guest of the plan this page shares joined it, or null for the host and outside a shared plan. */
  joinedAt(id: ParticipantId): Date | null {
    return this.#hosting?.joinedAt.get(id) ?? null;
  }

  /** Tells whether this page joined a plan in which it may not edit, so that its changes are refused while it is there. */
  get isReadOnly(): boolean {
    if (this.#mode.kind !== 'guest' && this.#mode.kind !== 'joining') {
      return false;
    }
    return !this.#participants.some(
      (participant) => participant.id === this.#me && participant.canEdit,
    );
  }

  /** Returns the other people in the shared plan by the task each one selected, in the order of the list, for the rows that show where they are. */
  get presence(): ReadonlyMap<TaskId, readonly Participant[]> {
    return this.#presence;
  }

  /** Returns the name of the host of the plan this page joined, or null. */
  get hostName(): string | null {
    return this.#participants.find((participant) => participant.isHost)?.name ?? null;
  }

  /** Reads the settings of this computer, a failure leaving the defaults unknown and being given back. */
  async loadSettings(): Promise<BridgeResult<CollaborationSettings>> {
    const read = await this.#context.bridge.collaborationSettings();
    if (read.ok) {
      this.#settings = read.value;
    }
    return read;
  }

  /** Changes and keeps the settings of this computer, reading them first when they were not read yet. */
  async saveSettings(changes: Partial<CollaborationSettings>): Promise<BridgeResult<null>> {
    let base = this.#settings;
    if (base === null) {
      const read = await this.loadSettings();
      if (!read.ok) {
        return read;
      }
      base = read.value;
    }
    const next = { ...base, ...changes };
    const saved = await this.#context.bridge.saveCollaborationSettings(next);
    if (saved.ok) {
      this.#settings = next;
    }
    return saved;
  }

  /** Changes the name of this person on this computer and tells it to the others in the shared plan. */
  async rename(name: string): Promise<BridgeResult<null>> {
    const saved = await this.saveSettings({ name });
    if (saved.ok) {
      this.#queuePresence();
    }
    return saved;
  }

  /** Copies the code of the plan this page shares, giving whether it was copied. */
  async copyCode(): Promise<boolean> {
    return (await this.#context.bridge.copyJoinCode()).ok;
  }

  /** Shares the open plan under the name of this person, which must be set first, and starts hosting it. */
  async share(): Promise<Result<Sharing, CollaborationFailure>> {
    const session = this.#context.session();
    const name = this.#settings?.name ?? null;
    if (session === null) {
      return { ok: false, error: { code: 'NO_PROJECT' } };
    }
    if (name === null) {
      return { ok: false, error: { code: 'NO_NAME' } };
    }
    const shared = await this.#context.bridge.sharePlan(session.project().name, name);
    if (!shared.ok) {
      return shared;
    }
    const hostId = requireParticipantId(this.#context.createId());
    const hosting: Hosting = {
      host: createHost({
        session,
        hostId,
        name,
        send: ({ to, message }) => {
          const peer = this.#hosting?.participantsByPeer.get(to);
          if (peer !== undefined) {
            this.#context.bridge.sendToCollaboration(peer, encodeMessage(message));
          }
        },
        report: (event) => {
          this.#report(event);
        },
      }),
      peers: new SvelteMap(),
      participantsByPeer: new SvelteMap(),
      joinedAt: new SvelteMap(),
    };
    this.#hosting = hosting;
    this.#me = hostId;
    this.#participants = hosting.host.roster().participants;
    this.#mode = { kind: 'hosting', sharing: shared.value };
    this.#queuePresence();
    return shared;
  }

  /** Joins a shared plan with its code under the name of this person, which must be set first, the plan opening once the host sent it. */
  async join(target: {
    readonly address: string;
    readonly port: number;
    readonly code: string;
  }): Promise<Result<null, CollaborationFailure>> {
    const name = this.#settings?.name ?? null;
    if (name === null) {
      return { ok: false, error: { code: 'NO_NAME' } };
    }
    await this.stop();
    const participantId = requireParticipantId(this.#context.createId());
    const joined = await this.#context.bridge.joinPlan({ ...target, participantId, name });
    if (!joined.ok) {
      return joined;
    }
    this.#me = participantId;
    this.#lastEnd = null;
    this.#mode = { kind: 'joining' };
    return joined;
  }

  /** Stops sharing or leaves the plan joined, keeping the open project as it is. */
  async stop(): Promise<void> {
    if (this.#mode.kind === 'idle') {
      return;
    }
    this.#forget();
    const stopped = await this.#context.bridge.stopCollaboration();
    if (!stopped.ok) {
      console.error('The shared plan could not be stopped:', stopped.error);
    }
  }

  /** Lets a participant edit or puts it back in read only, which only the host can do. */
  setRight(id: ParticipantId, canEdit: boolean): boolean {
    const hosting = this.#hosting;
    const changed = hosting?.host.setRight(id, canEdit);
    if (hosting === null || changed?.ok !== true) {
      return false;
    }
    this.#participants = hosting.host.roster().participants;
    return true;
  }

  /** Starts or stops the search for plans shared nearby. */
  async findPlans(searching: boolean): Promise<void> {
    if (!searching) {
      this.#nearby = [];
    }
    const asked = await this.#context.bridge.findPlans(searching);
    if (!asked.ok) {
      console.error('The search for shared plans could not change:', asked.error);
    }
  }

  /** Tells the others the task this person selected, once for all the changes of a moment. */
  selectionChanged(): void {
    this.#queuePresence();
  }

  /** Follows a session the page just opened: the plan it joined becomes the shared plan of its guest, any other project ends what the page shared or joined. */
  attached(session: SharedSession): void {
    if (!this.#openingShared) {
      void this.stop();
      return;
    }
    this.#openingShared = false;
    const guest = createGuest({
      session,
      send: (message) => {
        this.#context.bridge.sendToCollaboration('host', encodeMessage(message));
      },
      report: (event) => {
        this.#report(event);
      },
    });
    this.#guest = guest;
    this.#mode = { kind: 'guest', connected: true };
    if (this.#waitingRoster !== null) {
      guest.receive(this.#waitingRoster);
      this.#waitingRoster = null;
    }
    guest.connected();
    this.#queuePresence();
  }

  /** Forgets everything of the shared plan, without telling the main process. */
  #forget(): void {
    this.#hosting?.host.stop();
    this.#guest?.stop();
    this.#hosting = null;
    this.#guest = null;
    this.#waitingRoster = null;
    this.#openingShared = false;
    this.#participants = [];
    this.#me = null;
    this.#mode = { kind: 'idle' };
  }

  /** Handles an event of the main process about what the page shares or joined. */
  #receive(event: CollaborationEvent): void {
    switch (event.kind) {
      case 'peerJoined':
        this.#peerJoined(event.peer, event.participantId, event.name);
        return;
      case 'peerMessage':
        this.#fromPeer(event.peer, event.message);
        return;
      case 'peerLeft':
        this.#peerLeft(event.peer);
        return;
      case 'codeChanged':
        this.#codeChanged(event.code);
        return;
      case 'nearbyPlans':
        this.#nearby = event.plans;
        return;
      case 'connected':
        this.#context.bridge.sendToCollaboration(
          'host',
          encodeMessage({ kind: 'stateVector', vector: EMPTY_STATE_VECTOR }),
        );
        return;
      case 'hostMessage':
        this.#fromHost(event.message);
        return;
      case 'ended':
        this.#ended(event.reason);
    }
  }

  /** Adds a guest who proved it knows the code, known by its connection before the host sends it the people in the plan, and drops it when it claims an identifier already in the plan or the plan is full. */
  #peerJoined(peer: number, participantId: string, name: string): void {
    const hosting = this.#hosting;
    if (hosting === null) {
      return;
    }
    if (!isParticipantId(participantId) || hosting.participantsByPeer.has(participantId)) {
      this.#turnAway(peer, isParticipantId(participantId) ? 'ALREADY_IN' : 'INVALID_IDENTIFIER');
      return;
    }
    hosting.peers.set(peer, participantId);
    hosting.participantsByPeer.set(participantId, peer);
    const joined = hosting.host.connect(participantId, name);
    if (!joined.ok) {
      hosting.peers.delete(peer);
      hosting.participantsByPeer.delete(participantId);
      this.#turnAway(peer, joined.error);
      return;
    }
    hosting.joinedAt.set(participantId, this.#context.now());
    this.#participants = hosting.host.roster().participants;
  }

  /** Drops a guest the host refused, telling why in the log. */
  #turnAway(peer: number, reason: string): void {
    console.warn(`A guest was turned away from the shared plan: ${reason}.`);
    void this.#context.bridge.dropPeer(peer);
  }

  /** Passes a message of a guest to the host, a message that cannot be read being logged. */
  #fromPeer(peer: number, bytes: Uint8Array): void {
    const hosting = this.#hosting;
    const from = hosting?.peers.get(peer);
    if (hosting === null || from === undefined) {
      return;
    }
    const message = readMessage(bytes);
    if (!message.ok) {
      console.warn(`A message of a guest could not be read: ${message.error}.`);
      return;
    }
    hosting.host.receive(from, message.value);
    this.#participants = hosting.host.roster().participants;
  }

  /** Removes a guest who left. */
  #peerLeft(peer: number): void {
    const hosting = this.#hosting;
    const id = hosting?.peers.get(peer);
    if (hosting === null || id === undefined) {
      return;
    }
    hosting.peers.delete(peer);
    hosting.participantsByPeer.delete(id);
    hosting.joinedAt.delete(id);
    hosting.host.disconnect(id);
    this.#participants = hosting.host.roster().participants;
  }

  /** Shows the new code the host drew after too many wrong ones. */
  #codeChanged(code: string): void {
    if (this.#mode.kind === 'hosting') {
      this.#mode = { kind: 'hosting', sharing: { ...this.#mode.sharing, code } };
    }
  }

  /** Passes a message of the host to the guest, or, before the plan is open, keeps the list of people and opens the whole plan the host sent. */
  #fromHost(bytes: Uint8Array): void {
    const message = readMessage(bytes);
    if (!message.ok) {
      console.warn(`A message of the host could not be read: ${message.error}.`);
      return;
    }
    if (this.#guest !== null) {
      this.#guest.receive(message.value);
      return;
    }
    if (message.value.kind === 'participants') {
      this.#waitingRoster = message.value;
      this.#participants = message.value.participants;
      return;
    }
    if (message.value.kind === 'update' && this.#mode.kind === 'joining' && !this.#openingShared) {
      void this.#openPlan(message.value.update);
    }
  }

  /** Opens the whole plan the host sent, leaving the plan when it cannot be opened. */
  async #openPlan(state: Uint8Array): Promise<void> {
    this.#openingShared = true;
    const opened = await this.#context.openShared(state);
    if (!opened) {
      this.#openingShared = false;
      await this.stop();
    }
  }

  /** Tells that the connection to the host ended, keeping the plan open as it is: a plan already opened stays joined but offline, with the people last known, and an attempt to join ends. */
  #ended(reason: GuestEndReason): void {
    this.#lastEnd = reason;
    const guest = this.#guest;
    if (guest === null) {
      this.#forget();
      return;
    }
    guest.disconnected();
    guest.stop();
    this.#guest = null;
    this.#mode = { kind: 'guest', connected: false };
  }

  /** Handles what the host or the guest tells: repairs, refusals, the list of people and changes kept here. */
  #report(event: SyncEvent): void {
    switch (event.kind) {
      case 'repairs':
        this.#context.repaired(event.repairs);
        return;
      case 'refused':
        console.warn(
          `The shared plan refused a message${event.from === null ? '' : ` of ${event.from}`}: ${event.reason}.`,
        );
        return;
      case 'roster':
        this.#me = event.you;
        this.#participants = event.participants;
        return;
      case 'unsharedChanges':
        console.warn('Changes made in read only stay on this computer.');
    }
  }

  /** Sends the presence of this person once for all the selections of a moment. */
  #queuePresence(): void {
    if (this.#presenceQueued) {
      return;
    }
    this.#presenceQueued = true;
    queueMicrotask(() => {
      this.#presenceQueued = false;
      const name = this.#settings?.name ?? null;
      if (name === null) {
        return;
      }
      const selected = this.#context.selectedTaskId();
      this.#hosting?.host.setPresence(name, selected);
      this.#guest?.setPresence(name, selected);
      if (this.#hosting !== null) {
        this.#participants = this.#hosting.host.roster().participants;
      }
    });
  }
}

/** Groups the people other than this page by the task each one selected, in the order of the list. */
function presenceOf(
  participants: readonly Participant[],
  me: ParticipantId | null,
): ReadonlyMap<TaskId, readonly Participant[]> {
  const placed = participants.flatMap((participant) =>
    participant.id === me || participant.selectedTaskId === null
      ? []
      : [{ participant, task: participant.selectedTaskId }],
  );
  const grouped = Map.groupBy(placed, (entry) => entry.task);
  return new Map(
    [...grouped].map(([task, entries]) => [task, entries.map((entry) => entry.participant)]),
  );
}
