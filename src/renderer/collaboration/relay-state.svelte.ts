import {
  createRelayMember,
  type RelayMember,
  type RelayMemberEvent,
  type RelayPerson,
} from '../../core/collaboration/relay/relay-member';
import type { TaskId } from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import type { SharedRepair } from '../../core/shared/shared-project';
import type { SharedSession } from '../../core/shared/shared-session';
import type {
  CollaborationEvent,
  FileFailure,
  OpenedProject,
  RelayEndReason,
  RelayLinkKind,
  RelayLinks,
  ShownRelayLinks,
  TasklaceBridge,
} from '../../preload/bridge-contract';
import type { KeptOwnChanges } from './collaboration-state.svelte';
import { PERSON_COLORS } from '../theme/person-colors';

export type RelayBridge = Pick<
  TasklaceBridge,
  | 'shareThroughRelay'
  | 'joinByLink'
  | 'reopenSharedPlan'
  | 'makeNewLinks'
  | 'forgetSharedPlan'
  | 'copyRelayLink'
  | 'openGuide'
  | 'stopCollaboration'
  | 'sendToRelay'
  | 'keepOwnChanges'
>;

export interface RelayContext {
  readonly bridge: RelayBridge;
  readonly session: () => SharedSession | null;
  readonly openJoined: (project: OpenedProject) => Promise<boolean>;
  readonly repaired: (repairs: readonly SharedRepair[]) => void;
  readonly ownChangesKept: (kept: Result<KeptOwnChanges, FileFailure>) => void;
  readonly name: () => string | null;
  readonly selectedTaskId: () => TaskId | null;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly ended: (reason: RelayEndReason, relay: string) => void;
  readonly linkNotKept: () => void;
  readonly changeRefused: () => void;
  readonly notReopened: (failure: FileFailure) => void;
}

export interface ShownRelayPerson {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly canEdit: boolean;
  readonly selectedTaskId: TaskId | null;
}

export type RelayConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'lost';

export type RelayFailure = FileFailure | { readonly code: 'NO_PROJECT' };

type RelayEventKind = Extract<
  CollaborationEvent['kind'],
  `relay${string}` | 'reconnecting' | 'offline'
>;

type RelayEvent = Extract<CollaborationEvent, { readonly kind: RelayEventKind }>;

type Due = 'wholePlan' | null;

interface LostConnection {
  readonly kind: 'lost';
  readonly reason: RelayEndReason;
}

type PlanConnection = Exclude<RelayConnection, 'lost'> | LostConnection;

interface InPlan {
  readonly kind: 'in';
  readonly relay: string;
  readonly links: ShownRelayLinks;
  readonly kept: boolean;
  readonly connection: PlanConnection;
  readonly member: RelayMember | null;
  readonly bytesSinceSnapshot: number;
  readonly due: Due;
}

type RelayPhase = { readonly kind: 'idle' } | { readonly kind: 'starting' } | InPlan;

const NOBODY: ReadonlyMap<number, RelayPerson> = new Map();
const PERSON_ID_PREFIX = 'relay-';
const RELAY_EVENT_KINDS: ReadonlySet<CollaborationEvent['kind']> = new Set<RelayEventKind>([
  'relayConnected',
  'relayState',
  'relayDelivery',
  'relayCaughtUp',
  'relayPresence',
  'relayJoined',
  'relayLeft',
  'relayEnded',
  'reconnecting',
  'offline',
]);

/** Tells whether an event of the main process is one a plan shared through a relay follows, the connection to a relay coming and going included. */
export function isRelayEvent(event: CollaborationEvent): event is RelayEvent {
  return RELAY_EVENT_KINDS.has(event.kind);
}

/** Holds the plan the page shares through a relay: the member of the plan linked to the open session, the people in it and the state of the connection, holding what the main process tells until the member can take it. */
export class RelayState {
  #phase = $state.raw<RelayPhase>({ kind: 'idle' });
  #people = $state.raw<ReadonlyMap<number, RelayPerson>>(NOBODY);
  #lastEnd = $state.raw<RelayEndReason | null>(null);
  readonly #others = $derived(
    [...this.#people].map(([member, person], index) => ({
      ...person,
      id: `${PERSON_ID_PREFIX}${String(member)}`,
      color: (index + 1) % PERSON_COLORS.length,
    })),
  );
  #held: RelayEvent[] = [];
  #generation = 0;
  readonly #context: RelayContext;

  /** Starts with no plan shared through a relay. */
  constructor(context: RelayContext) {
    this.#context = context;
  }

  /** Tells whether the page shares a plan through a relay, or is about to. */
  get isActive(): boolean {
    return this.#phase.kind !== 'idle';
  }

  /** Tells whether the page waits for the main process to answer a request to share, join or come back to a plan. */
  get isStarting(): boolean {
    return this.#phase.kind === 'starting';
  }

  /** Tells whether the page waits for a plan it joined by a link to open. */
  get isOpening(): boolean {
    return this.#phase.kind === 'in' && this.#phase.member === null;
  }

  /** Returns the state of the connection to the relay, or null outside a plan shared through one. */
  get connection(): RelayConnection | null {
    if (this.#phase.kind !== 'in') {
      return null;
    }
    const { connection } = this.#phase;
    return typeof connection === 'string' ? connection : connection.kind;
  }

  /** Returns the relay as a person reads it, or null. */
  get relay(): string | null {
    return this.#phase.kind === 'in' ? this.#phase.relay : null;
  }

  /** Returns the links of the plan as this page may show them, the link that edits only when it holds it, or null outside a plan shared through a relay. */
  get links(): ShownRelayLinks | null {
    return this.#phase.kind === 'in' ? this.#phase.links : null;
  }

  /** Tells whether this computer keeps the link of the plan shared through a relay, so that it comes back to it once reopened, which it does not without a safe place for it. */
  get isLinkKept(): boolean {
    return this.#phase.kind === 'in' && this.#phase.kept;
  }

  /** Tells whether this page holds the link that edits the plan it shares through a relay. */
  get canEdit(): boolean {
    return this.#phase.kind === 'in' && this.#phase.links.edit !== null;
  }

  /** Tells whether this page holds only the link that reads the plan, which then never changes here. */
  get isReadOnly(): boolean {
    return this.#phase.kind === 'in' && this.#phase.links.edit === null;
  }

  /** Returns the other people in the plan by their number on the relay. */
  get people(): ReadonlyMap<number, RelayPerson> {
    return this.#people;
  }

  /** Returns the other people in the plan as the interface shows them, in the order they came, each with a color after the first one, which is this person's own. */
  get others(): readonly ShownRelayPerson[] {
    return this.#others;
  }

  /** Returns why the relay ended the plan still open here, with that relay as a person reads it, or null while it has not. */
  get endOfOpenPlan(): { readonly reason: RelayEndReason; readonly relay: string } | null {
    const phase = this.#phase;
    return phase.kind === 'in' && typeof phase.connection !== 'string'
      ? { reason: phase.connection.reason, relay: phase.relay }
      : null;
  }

  /** Returns why the latest plan shared through a relay ended, or null. */
  get lastEnd(): RelayEndReason | null {
    return this.#lastEnd;
  }

  /** Shares the open plan through a relay, the whole plan going on the relay once in. */
  async share(address: string): Promise<Result<RelayLinks, RelayFailure>> {
    const session = this.#context.session();
    if (session === null) {
      return failure({ code: 'NO_PROJECT' });
    }
    const generation = this.#start();
    const shared = await this.#context.bridge.shareThroughRelay(address);
    if (generation !== this.#generation) {
      return failure({ code: 'CANCELLED' });
    }
    if (!shared.ok) {
      this.#forget();
      return shared;
    }
    const { relay, shown, kept } = shared.value;
    this.#enter(session, { relay, links: shown, kept, due: 'wholePlan' });
    return shared;
  }

  /** Joins a plan by its link, the plan opening in the page once the relay passed it on and the main process checked it. */
  async join(link: string): Promise<Result<null, RelayFailure>> {
    const generation = this.#start();
    const joined = await this.#context.bridge.joinByLink(link);
    if (generation !== this.#generation) {
      return failure({ code: 'CANCELLED' });
    }
    if (!joined.ok) {
      this.#forget();
      return joined;
    }
    const { project, shown, relay, bytesSinceSnapshot, kept } = joined.value;
    this.#phase = {
      kind: 'in',
      relay,
      links: shown,
      kept,
      connection: 'connected',
      member: null,
      bytesSinceSnapshot,
      due: null,
    };
    if (!(await this.#context.openJoined(project))) {
      await this.stop();
      return failure({ code: 'CANCELLED' });
    }
    if (!kept) {
      this.#context.linkNotKept();
    }
    return success(null);
  }

  /** Follows the session of the plan the page joined by a link once it opened, the relay having already caught it up. */
  attached(session: SharedSession): void {
    const phase = this.#phase;
    if (phase.kind !== 'in' || phase.member !== null) {
      return;
    }
    const member = this.#member(session, phase.links.edit !== null, phase.bytesSinceSnapshot);
    this.#phase = { ...phase, member };
    member.caughtUp();
    this.selectionChanged();
    this.#release();
  }

  /** Comes back to the relay of a plan the page opened when this computer kept its link, giving whether it does. */
  async reopen(session: SharedSession): Promise<boolean> {
    const generation = this.#start();
    const reopened = await this.#context.bridge.reopenSharedPlan(session.documentId);
    if (generation !== this.#generation) {
      return false;
    }
    if (!reopened.ok || reopened.value === null) {
      if (!reopened.ok) {
        console.error('The plan could not come back to its relay:', reopened.error);
        this.#context.notReopened(reopened.error);
      }
      this.#forget();
      return false;
    }
    const { relay, shown } = reopened.value;
    this.#enter(session, { relay, links: shown, kept: true, due: null });
    return true;
  }

  /** Makes new links for the plan this page shares, the old ones no longer letting anyone in, and puts the whole plan in the new room once in. */
  async makeNewLinks(): Promise<Result<RelayLinks, FileFailure>> {
    const phase = this.#phase;
    if (phase.kind !== 'in' || phase.links.edit === null) {
      return failure({ code: 'TASK_FAILED' });
    }
    const made = await this.#context.bridge.makeNewLinks();
    const current = this.#phase;
    if (made.ok && current.kind === 'in') {
      current.member?.disconnected();
      this.#phase = {
        ...current,
        links: made.value.shown,
        kept: made.value.kept,
        connection: 'connecting',
        due: 'wholePlan',
      };
    }
    return made;
  }

  /** Copies a link of the plan this page shares through a relay, the main process holding it, and gives whether it was copied. */
  async copyLink(kind: RelayLinkKind): Promise<boolean> {
    return (await this.#context.bridge.copyRelayLink(kind)).ok;
  }

  /** Opens in the browser the guide that explains how to set up a relay, giving whether it opened. */
  async openGuide(): Promise<boolean> {
    return (await this.#context.bridge.openGuide()).ok;
  }

  /** Tells the others the task this person selected. */
  selectionChanged(): void {
    const name = this.#context.name();
    if (this.#phase.kind === 'in' && name !== null) {
      this.#phase.member?.setPresence(name, this.#context.selectedTaskId());
    }
  }

  /** Leaves the plan shared through a relay, keeping the open plan as it is. */
  async stop(): Promise<void> {
    if (!this.isActive) {
      return;
    }
    this.#forget();
    const stopped = await this.#context.bridge.stopCollaboration();
    if (!stopped.ok) {
      console.error('The plan shared through a relay could not be left:', stopped.error);
    }
  }

  /** Forgets for good a plan whose room the relay no longer finds, with the link this computer kept for it, giving whether it was forgotten. */
  async forgetPlan(): Promise<boolean> {
    const phase = this.#phase;
    if (
      phase.kind !== 'in' ||
      typeof phase.connection === 'string' ||
      phase.connection.reason !== 'NO_ROOM'
    ) {
      return false;
    }
    const forgotten = await this.#context.bridge.forgetSharedPlan();
    if (!forgotten.ok) {
      console.error('The shared plan could not be forgotten:', forgotten.error);
      return false;
    }
    this.#forget();
    return true;
  }

  /** Forgets the plan shared through a relay without telling the main process, which already stopped it. */
  forget(): void {
    this.#forget();
  }

  /** Handles an event of the main process about the plan shared through a relay, holding it until the member can take it. */
  receive(event: RelayEvent): void {
    const phase = this.#phase;
    if (phase.kind !== 'in' || phase.member === null) {
      this.#held.push(event);
      return;
    }
    this.#act(phase, phase.member, event);
  }

  /** Acts on an event of the main process with the member of the plan, telling a newcomer where this person is. */
  #act(phase: InPlan, member: RelayMember, event: RelayEvent): void {
    switch (event.kind) {
      case 'relayConnected':
        this.#phase = { ...phase, connection: 'connected' };
        return;
      case 'relayState':
        member.catchUpWith(event.state, event.bytesSinceSnapshot);
        return;
      case 'relayCaughtUp':
        this.#caughtUp(phase, member);
        return;
      case 'relayDelivery':
        member.receive(event.delivery);
        return;
      case 'relayPresence':
        member.presence(event.member, event.presence);
        return;
      case 'relayJoined':
        this.selectionChanged();
        return;
      case 'relayLeft':
        member.left(event.member);
        return;
      case 'reconnecting':
      case 'offline':
        member.disconnected();
        this.#phase = { ...phase, connection: event.kind };
        return;
      case 'relayEnded':
        this.#ended(phase, member, event.reason);
    }
  }

  /** Lets the member send what it keeps once caught up, the whole plan alone when it was just shared since it holds every change kept, and tells the others where this person is. */
  #caughtUp(phase: InPlan, member: RelayMember): void {
    if (phase.due === 'wholePlan') {
      member.shareWholePlan();
    }
    member.caughtUp();
    this.#phase = { ...phase, due: null };
    this.selectionChanged();
  }

  /** Keeps the plan open as it is once the relay ended it for good, its connection lost, and tells the page why. */
  #ended(phase: InPlan, member: RelayMember, reason: RelayEndReason): void {
    this.#lastEnd = reason;
    member.disconnected();
    member.stop();
    this.#phase = { ...phase, connection: { kind: 'lost', reason } };
    this.#context.ended(reason, phase.relay);
  }

  /** Starts a request to the main process, holding its events until it answers, and gives the generation it belongs to. */
  #start(): number {
    this.#forget();
    this.#phase = { kind: 'starting' };
    this.#lastEnd = null;
    return this.#generation;
  }

  /** Follows the plan of the open session through a relay with a new member, which edits when the page holds the link that does, then hands it what came meanwhile. */
  #enter(session: SharedSession, start: Pick<InPlan, 'relay' | 'links' | 'kept' | 'due'>): void {
    const member = this.#member(session, start.links.edit !== null, 0);
    this.#phase = {
      kind: 'in',
      ...start,
      connection: 'connecting',
      member,
      bytesSinceSnapshot: 0,
    };
    this.#release();
  }

  /** Creates the member of the plan, linked to the open session and to what the main process carries. */
  #member(session: SharedSession, canEdit: boolean, bytesSinceSnapshot: number): RelayMember {
    return createRelayMember({
      session,
      canEdit,
      bytesSinceSnapshot,
      randomBytes: this.#context.randomBytes,
      send: (outgoing) => {
        this.#context.bridge.sendToRelay(outgoing);
      },
      report: (event) => {
        this.#report(event);
      },
    });
  }

  /** Hands the member the events held while it did not exist. */
  #release(): void {
    const held = this.#held;
    this.#held = [];
    held.forEach((event) => {
      this.receive(event);
    });
  }

  /** Forgets everything of the plan shared through a relay. */
  #forget(): void {
    if (this.#phase.kind === 'in') {
      this.#phase.member?.stop();
    }
    this.#phase = { kind: 'idle' };
    this.#people = NOBODY;
    this.#held = [];
    this.#generation += 1;
  }

  /** Handles what the member tells: repairs, refusals, the people in the plan and changes only this computer holds. */
  #report(event: RelayMemberEvent): void {
    switch (event.kind) {
      case 'repairs':
        this.#context.repaired(event.repairs);
        return;
      case 'refused':
        console.warn(`The plan shared through a relay refused a message: ${event.reason}.`);
        this.#context.changeRefused();
        return;
      case 'people':
        this.#people = event.people;
        return;
      case 'unsharedChanges':
        void this.#keepOwnChanges();
    }
  }

  /** Keeps apart, in a plan of its own on this computer, changes this computer holds that the relay lacks while only the link that reads the plan is held here. */
  async #keepOwnChanges(): Promise<void> {
    const session = this.#context.session();
    if (session === null) {
      return;
    }
    const planName = session.project().name;
    const kept = await this.#context.bridge.keepOwnChanges(session.encodeState(), planName);
    if (!kept.ok) {
      console.error('The changes this computer holds could not be kept apart:', kept.error);
      this.#context.ownChangesKept(kept);
      return;
    }
    this.#context.ownChangesKept(success({ planName, localCopySaved: kept.value.localCopySaved }));
  }
}
