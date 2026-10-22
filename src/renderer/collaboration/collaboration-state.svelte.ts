import { SvelteMap } from 'svelte/reactivity';
import {
  encodeMessage,
  readMessage,
  type CollaborationMessage,
} from '../../core/collaboration/messages';
import {
  isParticipantId,
  requireParticipantId,
  type Endpoint,
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
import { takeOverRoster, type Roster } from '../../core/collaboration/roster';
import { successionQueue } from '../../core/collaboration/succession';
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
  | 'findNextHost'
  | 'keepOwnChanges'
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
  readonly hostChanged: (left: string | null, next: string | null) => void;
  readonly ownChangesKept: (kept: Result<string, FileFailure>) => void;
  readonly selectedTaskId: () => TaskId | null;
}

export type CollaborationMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hosting'; readonly sharing: Sharing }
  | { readonly kind: 'joining' }
  | { readonly kind: 'guest'; readonly connection: GuestConnection };

export type GuestConnection = 'connected' | 'reconnecting' | 'offline' | 'lost';

export type CollaborationFailure = FileFailure | { readonly code: 'NO_NAME' | 'NO_PROJECT' };

export const EMPTY_STATE_VECTOR = Uint8Array.of(0);

const NOBODY_PLACED: ReadonlyMap<TaskId, readonly Participant[]> = new Map();

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
  readonly #presence = $derived.by(() =>
    this.#mode.kind === 'guest' && this.#mode.connection !== 'connected'
      ? NOBODY_PLACED
      : presenceOf(this.#participants, this.#me),
  );
  readonly #context: CollaborationContext;
  #hosting: Hosting | null = null;
  #guest: Guest | null = null;
  #waitingRoster: CollaborationMessage | null = null;
  #openingShared = false;
  #presenceQueued = false;
  #hostThatLeft: string | null = null;
  #keepingChanges = false;

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

  /** Tells whether the host lets this person edit the plan joined, as last known, so that the changes made away from the host are shared on coming back rather than kept apart. */
  get canEdit(): boolean {
    return this.#participants.some(
      (participant) => participant.id === this.#me && participant.canEdit,
    );
  }

  /** Tells whether this page is connected to a plan in which it may not edit, so that its changes are refused while it is there, changes made away from the host being kept apart once back. */
  get isReadOnly(): boolean {
    const connected = this.#mode.kind === 'guest' && this.#mode.connection === 'connected';
    if (!connected && this.#mode.kind !== 'joining') {
      return false;
    }
    return !this.canEdit;
  }

  /** Returns the other people in the shared plan by the task each one selected, in the order of the list, or nobody while the connection to the host is lost, since where they are is then unknown. */
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
    const hostId = requireParticipantId(this.#context.createId());
    const shared = await this.#context.bridge.sharePlan(session.project().name, name, hostId);
    if (!shared.ok) {
      return shared;
    }
    this.#startHost(session, { hostId, name, roster: null }, shared.value);
    return shared;
  }

  /** Hosts the shared plan of the open session, from a new list or one taken over from a host that left, linking the host to the messages the main process carries. */
  #startHost(
    session: SharedSession,
    start: {
      readonly hostId: ParticipantId;
      readonly name: string;
      readonly roster: Roster | null;
    },
    sharing: Sharing,
  ): void {
    const hosting: Hosting = {
      host: createHost({
        session,
        ...start,
        tokenDigest: sharing.tokenDigest,
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
    this.#me = start.hostId;
    this.#participants = hosting.host.roster().participants;
    this.#mode = { kind: 'hosting', sharing };
    this.#queuePresence();
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
    const guest = this.#startGuest(session);
    this.#mode = { kind: 'guest', connection: 'connected' };
    if (this.#waitingRoster !== null) {
      guest.receive(this.#waitingRoster);
      this.#waitingRoster = null;
    }
    guest.connected();
    this.#queuePresence();
  }

  /** Follows the shared plan of the open session as a guest, linking it to the messages the main process carries. */
  #startGuest(session: SharedSession): Guest {
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
    return guest;
  }

  /** Forgets everything of the shared plan, without telling the main process. */
  #forget(): void {
    this.#hosting?.host.stop();
    this.#guest?.stop();
    this.#hosting = null;
    this.#guest = null;
    this.#waitingRoster = null;
    this.#openingShared = false;
    this.#hostThatLeft = null;
    this.#keepingChanges = false;
    this.#participants = [];
    this.#me = null;
    this.#mode = { kind: 'idle' };
  }

  /** Handles an event of the main process about what the page shares or joined. */
  #receive(event: CollaborationEvent): void {
    switch (event.kind) {
      case 'peerJoined':
        this.#peerJoined(event.peer, event.participantId, event.name, {
          endpoint: event.endpoint,
          tokenDigest: event.tokenDigest,
        });
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
        this.#connected();
        return;
      case 'reconnecting':
        this.#connectionLost(event.kind);
        return;
      case 'offline':
      case 'hostLeft':
        this.#connectionLost(event.kind === 'offline' ? 'offline' : 'reconnecting');
        void this.#findNextHost();
        return;
      case 'becameHost':
        this.#becameHost(event.sharing);
        return;
      case 'yielded':
        this.#yielded();
        return;
      case 'hostMessage':
        this.#fromHost(event.message);
        return;
      case 'ended':
        this.#ended(event.reason);
    }
  }

  /** Follows a connection to the host that opened: a first one asks for the whole plan with an empty state vector, one that came back brings the guest of the plan back in step. */
  #connected(): void {
    const guest = this.#guest;
    if (guest === null) {
      this.#context.bridge.sendToCollaboration(
        'host',
        encodeMessage({ kind: 'stateVector', vector: EMPTY_STATE_VECTOR }),
      );
      return;
    }
    guest.connected();
    this.#mode = { kind: 'guest', connection: 'connected' };
    this.#queuePresence();
  }

  /** Follows a connection to the host lost while the main process tries to come back, the plan staying open and its changes kept here meanwhile. */
  #connectionLost(connection: 'reconnecting' | 'offline'): void {
    const guest = this.#guest;
    if (guest === null) {
      return;
    }
    guest.disconnected();
    this.#mode = { kind: 'guest', connection };
  }

  /** Asks the main process to look for the next host of the plan joined, giving it the people last known from the oldest to the newest, and remembers which host left. */
  async #findNextHost(): Promise<void> {
    const session = this.#context.session();
    const name = this.#settings?.name ?? null;
    if (this.#guest === null || session === null || name === null || this.#hostThatLeft !== null) {
      return;
    }
    this.#hostThatLeft = this.hostName;
    const queue = successionQueue(this.#participants).map((participant) => ({
      participantId: participant.id,
      rank: participant.rank,
      endpoint: participant.endpoint,
    }));
    const knownTokens = this.#participants.flatMap((participant) =>
      participant.tokenDigest === null
        ? []
        : [{ participantId: participant.id, tokenDigest: participant.tokenDigest }],
    );
    const asked = await this.#context.bridge.findNextHost(
      queue,
      session.project().name,
      name,
      knownTokens,
    );
    if (!asked.ok) {
      console.error('The next host of the shared plan could not be looked for:', asked.error);
    }
  }

  /** Hosts the plan joined once its host left and this person's turn came, with the people last known, everyone else coming back with the rank and right they had. */
  #becameHost(sharing: Sharing): void {
    const session = this.#context.session();
    const me = this.#me;
    const name = this.#settings?.name ?? null;
    const roster = me === null ? null : takeOverRoster(rosterOf(this.#participants), me);
    if (session === null || me === null || name === null || roster === null) {
      console.error('The page cannot host the plan it was told to host.');
      return;
    }
    this.#guest?.stop();
    this.#guest = null;
    this.#startHost(session, { hostId: me, name, roster }, sharing);
    this.#context.hostChanged(this.#hostThatLeft, null);
    this.#hostThatLeft = null;
  }

  /** Gives way to an older host of the same plan: stops hosting and follows the plan as a guest until the main process joins that host. */
  #yielded(): void {
    const session = this.#context.session();
    if (this.#hosting === null || session === null) {
      return;
    }
    this.#hosting.host.stop();
    this.#hosting = null;
    this.#startGuest(session).disconnected();
    this.#mode = { kind: 'guest', connection: 'reconnecting' };
  }

  /** Adds a guest who proved it knows the code, known by its connection before the host sends it the people in the plan, a person coming back on a new connection replacing its old one, and drops a guest the plan cannot take. */
  #peerJoined(
    peer: number,
    participantId: string,
    name: string,
    known: { readonly endpoint: Endpoint; readonly tokenDigest: string },
  ): void {
    const hosting = this.#hosting;
    if (hosting === null) {
      return;
    }
    if (!isParticipantId(participantId)) {
      this.#turnAway(peer, 'INVALID_IDENTIFIER');
      return;
    }
    const previous = hosting.participantsByPeer.get(participantId);
    if (previous !== undefined) {
      this.#replaceConnection(hosting, previous, participantId);
    }
    hosting.peers.set(peer, participantId);
    hosting.participantsByPeer.set(participantId, peer);
    const joined = hosting.host.connect(participantId, name, known.endpoint, known.tokenDigest);
    if (!joined.ok) {
      hosting.peers.delete(peer);
      hosting.participantsByPeer.delete(participantId);
      this.#turnAway(peer, joined.error);
      return;
    }
    hosting.joinedAt.set(participantId, this.#context.now());
    this.#participants = hosting.host.roster().participants;
  }

  /** Forgets the old connection of a person who came back on a new one, the main process having checked it is the same person, and closes it. */
  #replaceConnection(hosting: Hosting, previous: number, id: ParticipantId): void {
    hosting.peers.delete(previous);
    hosting.participantsByPeer.delete(id);
    hosting.host.disconnect(id);
    void this.#context.bridge.dropPeer(previous);
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
    const awaitsPlan = this.#mode.kind === 'joining' || this.#keepingChanges;
    if (message.value.kind === 'update' && awaitsPlan && !this.#openingShared) {
      void this.#openPlan(message.value.update);
    }
  }

  /** Opens the whole plan the host sent, leaving the plan when it cannot be opened. */
  async #openPlan(state: Uint8Array): Promise<void> {
    this.#openingShared = true;
    const opened = await this.#context.openShared(state);
    this.#keepingChanges = false;
    if (!opened) {
      this.#openingShared = false;
      await this.stop();
    }
  }

  /** Keeps apart, in a plan of its own on this computer, the changes this person made away from the host while in read only, then asks the host for the whole shared plan to show it again as it is. */
  async #keepOwnChanges(): Promise<void> {
    const session = this.#context.session();
    const guest = this.#guest;
    if (session === null || guest === null || this.#keepingChanges) {
      return;
    }
    this.#keepingChanges = true;
    const planName = session.project().name;
    const kept = await this.#context.bridge.keepOwnChanges(session.encodeState(), planName);
    if (!kept.ok) {
      this.#keepingChanges = false;
      console.error('The changes made in read only could not be kept apart:', kept.error);
      this.#context.ownChangesKept(kept);
      return;
    }
    guest.stop();
    this.#guest = null;
    const me = this.#me;
    this.#waitingRoster =
      me === null ? null : { kind: 'participants', you: me, participants: this.#participants };
    this.#context.bridge.sendToCollaboration(
      'host',
      encodeMessage({ kind: 'stateVector', vector: EMPTY_STATE_VECTOR }),
    );
    this.#context.ownChangesKept({ ok: true, value: planName });
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
    this.#mode = { kind: 'guest', connection: 'lost' };
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
        this.#tellNewHost(event.participants);
        return;
      case 'unsharedChanges':
        void this.#keepOwnChanges();
    }
  }

  /** Tells the person the plan has a new host once the first list of people from it arrives after the host left. */
  #tellNewHost(participants: readonly Participant[]): void {
    const host = participants.find((participant) => participant.isHost);
    if (this.#hostThatLeft === null || this.#mode.kind !== 'guest' || host === undefined) {
      return;
    }
    this.#context.hostChanged(this.#hostThatLeft, host.name);
    this.#hostThatLeft = null;
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

/** Builds the list a guest knows of a plan, without the departures only the host knew, the next rank following the highest one known. */
function rosterOf(participants: readonly Participant[]): Roster {
  const highest = Math.max(0, ...participants.map((participant) => participant.rank));
  return { participants, departed: [], nextRank: highest + 1 };
}
