import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join as joinPath } from 'node:path';
import type { IpcMainEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import { readEndpoint } from '../../core/collaboration/endpoint';
import { isParticipantId, type ParticipantId } from '../../core/collaboration/participants';
import { isPort } from '../../core/collaboration/ports';
import { compressMessage } from '../../core/collaboration/secure/channel';
import { readJoinCode, type JoinCode } from '../../core/collaboration/secure/join-code';
import { drawRejoinToken, type Introduction } from '../../core/collaboration/secure/link';
import { isTokenDigest } from '../../core/collaboration/secure/token-digest';
import {
  MAX_COLLABORATION_MESSAGE_BYTES,
  MAX_DEPARTED_PARTICIPANTS,
  MAX_ENDPOINT_ADDRESSES,
  MAX_JOIN_RANK,
  MAX_PARTICIPANT_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_PROJECT_NAME_LENGTH,
} from '../../core/limits';
import { failure, success } from '../../core/result';
import { createIssueList } from '../../core/validation/validation-issues';
import {
  childField,
  itemField,
  readArray,
  identifierReader,
  readInteger,
  readNullable,
  readRecord,
  readText,
} from '../../core/validation/value-readers';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type CollaborationEvent,
  type CollaborationTarget,
  type KnownPerson,
  type CollaborationSettings,
  type InvokeChannel,
  type NearbyPlan,
  type OpenedProject,
  type Sharing,
} from '../../preload/bridge-contract';
import type { FileTask, ResultOfTask } from '../file-tasks';
import { handleChannel, type ChannelHandler } from '../ipc-channels';
import { readProjectState } from '../ipc-validators';
import { refuseMessage, type TrustCheck } from '../ipc-trust';
import { offerSharedProject } from '../project-files';
import { isSystemError } from '../stored-files';
import { systemRandomBytes } from './aes-gcm';
import {
  loadCollaborationSettings,
  readCollaborationSettings,
  storeCollaborationSettings,
} from './collaboration-settings';
import { findPlans, type Mdns, type NearbyPlan as HeardPlan } from './discovery';
import { isHostAddress } from './guest-client';
import { isPrivateAddress } from './private-addresses';
import { zlibCompressor } from '../zlib-compressor';
import type { Peer } from './host-server';
import type { StartTimer } from './secure-connection';
import type { SuccessionCandidate } from './succession-driver';
import {
  createWindowSharing,
  type PlanNames,
  type WindowSharing,
  type WindowStateView,
} from './window-sharing';

export interface CollaborationServices {
  readonly assertTrusted: TrustCheck;
  readonly userDataFolder: string;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly createMdns: () => { readonly mdns: Mdns; readonly destroy: () => void };
  readonly copyText: (text: string) => Promise<void>;
  readonly addresses?: () => readonly string[];
  readonly startTimer?: StartTimer;
  readonly now?: () => number;
  readonly randomBytes?: (count: number) => Uint8Array;
  readonly sharesElsewhere?: (sender: WebContents) => boolean;
  readonly leaveElsewhere?: (sender: WebContents) => Promise<void>;
}

interface CheckedJoinRequest {
  readonly address: string;
  readonly port: number;
  readonly code: JoinCode;
  readonly participantId: ParticipantId;
  readonly name: string;
}

const SETTINGS_STORE = 'collaboration-settings.json';
const CANDIDATE_KEYS = ['participantId', 'rank', 'endpoint'];
const INSTANCE_BYTES = 8;
const HEX_BASE = 16;
const HEX_DIGITS = 2;

/** Starts a timer with the clock of the system, returning how to stop it. */
export const systemTimer: StartTimer = (milliseconds, onEnd) => {
  const timer = setTimeout(onEnd, milliseconds);
  return () => {
    clearTimeout(timer);
  };
};

/** Lists the addresses of this computer on its private networks, IPv4 first, for a person who must type the address of the host. */
export function privateAddressesOf(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): readonly string[] {
  const found = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && isPrivateAddress(entry.address));
  return [
    ...found.filter((entry) => entry.family === 'IPv4'),
    ...found.filter((entry) => entry.family === 'IPv6'),
  ].map((entry) => entry.address);
}

/** Answers the collaboration requests of the bridge, passing the encoded messages of each window without reading the plan, and returns how to stop a window that reloads or closes. */
export function registerCollaborationHandlers(services: CollaborationServices): {
  readonly forgetWindow: (sender: WebContents) => void;
  readonly isBusy: (sender: WebContents) => boolean;
} {
  const windows = new Map<WebContents, WindowSharing>();
  const searches = new Map<WebContents, () => void>();
  const starting = new Set<WebContents>();
  const generations = new WeakMap<WebContents, number>();
  const storePath = joinPath(services.userDataFolder, SETTINGS_STORE);
  const startTimer = services.startTimer ?? systemTimer;
  const now = services.now ?? (() => Date.now());
  const randomBytes = services.randomBytes ?? systemRandomBytes;
  const addresses = services.addresses ?? (() => privateAddressesOf(networkInterfaces()));
  let mdns: { readonly mdns: Mdns; readonly destroy: () => void } | null = null;
  /** Gives the mDNS of the application, started on first use. */
  const sharedMdns = (): Mdns => {
    mdns ??= services.createMdns();
    return mdns.mdns;
  };
  /** Registers the answer of a channel, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, answer);
  };
  /** Gives what a window shares or joined, created on first use. */
  const windowOf = (sender: WebContents): WindowSharing => {
    const known = windows.get(sender);
    if (known !== undefined) {
      return known;
    }
    const created = createWindowSharing({
      tell: (event) => {
        tell(sender, event);
      },
      startTimer,
      now,
      mdns: sharedMdns,
      addresses,
      instance: () => instanceName(randomBytes),
      randomBytes,
    });
    windows.set(sender, created);
    return created;
  };
  /** Tells whether a window already shares, joined or looks for a host on the network. */
  const isBusyHere = (sender: WebContents): boolean =>
    starting.has(sender) || (windows.get(sender)?.state().kind ?? 'idle') !== 'idle';
  /** Tells whether a window already shares a plan, on the network or another way, a plan being shared one way only. */
  const isBusy = (sender: WebContents): boolean =>
    isBusyHere(sender) || (services.sharesElsewhere?.(sender) ?? false);
  /** Tells whether what a window started was stopped since, by its page or its window closing. */
  const stoppedSince = (sender: WebContents, generation: number): boolean =>
    (generations.get(sender) ?? 0) !== generation;
  /** Builds who a window is to the others: its identifier, its name, a token of its own and where it could host the plan, with the port of the settings of this computer. */
  const identityOf = async (
    participantId: ParticipantId,
    name: string,
  ): Promise<BridgeResult<Introduction>> => {
    const settings = await readSettings(storePath);
    if (!settings.ok) {
      return settings;
    }
    return success({
      participantId,
      name,
      token: drawRejoinToken(randomBytes),
      endpoint: {
        addresses: addresses().slice(0, MAX_ENDPOINT_ADDRESSES),
        port: settings.value.port,
      },
    });
  };
  /** Stops what a window shares or joined, and its search for plans nearby. */
  const stopWindow = async (sender: WebContents): Promise<void> => {
    generations.set(sender, (generations.get(sender) ?? 0) + 1);
    starting.delete(sender);
    searches.get(sender)?.();
    searches.delete(sender);
    const sharing = windows.get(sender);
    windows.delete(sender);
    await sharing?.stop();
    if (windows.size === 0 && searches.size === 0) {
      mdns?.destroy();
      mdns = null;
    }
  };
  /** Hosts the plan of a window under the identity of its person, stopping the server at once when the window was stopped meanwhile. */
  const startSharing = async (
    sender: WebContents,
    generation: number,
    names: PlanNames,
    id: ParticipantId,
  ): Promise<BridgeResult<Sharing>> => {
    const identity = await identityOf(id, names.hostName);
    if (stoppedSince(sender, generation)) {
      return failure({ code: 'CANCELLED' });
    }
    if (!identity.ok) {
      return identity;
    }
    const sharing = windowOf(sender);
    const hosted = await sharing.host(names, identity.value, identity.value.endpoint.port);
    if (!stoppedSince(sender, generation)) {
      return hosted.ok ? hosted : failure({ code: hosted.error });
    }
    await sharing.stop();
    return failure({ code: 'CANCELLED' });
  };
  handle(IPC_CHANNELS.collaborationSettings, () => readSettings(storePath));
  handle(IPC_CHANNELS.saveCollaborationSettings, (_event, value) =>
    saveSettings(storePath, readCollaborationSettings(value) ?? refuseMessage()),
  );
  handle(IPC_CHANNELS.sharePlan, async (event, planName, hostName, participantId) => {
    const names = readSharingNames(planName, hostName) ?? refuseMessage();
    const id = isParticipantId(participantId) ? participantId : refuseMessage();
    if (isBusy(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    starting.add(event.sender);
    const generation = generations.get(event.sender) ?? 0;
    try {
      return await startSharing(event.sender, generation, names, id);
    } finally {
      if (!stoppedSince(event.sender, generation)) {
        starting.delete(event.sender);
      }
    }
  });
  handle(IPC_CHANNELS.stopCollaboration, async (event) => {
    await stopWindow(event.sender);
    await services.leaveElsewhere?.(event.sender);
    return success(null);
  });
  handle(IPC_CHANNELS.joinPlan, async (event, value) => {
    const request = readJoinRequest(value) ?? refuseMessage();
    if (!isHostAddress(request.address) || !isPort(request.port)) {
      return failure({ code: 'INVALID_ADDRESS' });
    }
    if (isBusy(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    starting.add(event.sender);
    const generation = generations.get(event.sender) ?? 0;
    const identity = await identityOf(request.participantId, request.name);
    if (stoppedSince(event.sender, generation)) {
      return failure({ code: 'CANCELLED' });
    }
    starting.delete(event.sender);
    if (!identity.ok) {
      return identity;
    }
    windowOf(event.sender).join(request, identity.value);
    return success(null);
  });
  handle(IPC_CHANNELS.findNextHost, async (event, queue, planName, hostName, people) => {
    const candidates = readSuccessionQueue(queue) ?? refuseMessage();
    const names = readSharingNames(planName, hostName) ?? refuseMessage();
    const knownPeople = readKnownPeople(people) ?? refuseMessage();
    const settings = await readSettings(storePath);
    if (!settings.ok) {
      return settings;
    }
    if (!windowOf(event.sender).succeed(candidates, names, settings.value.port, knownPeople)) {
      console.error('A page looked for the next host without having joined a plan with its key.');
      return failure({ code: 'TASK_FAILED' });
    }
    return success(null);
  });
  handle(IPC_CHANNELS.copyJoinCode, async (event) => {
    const state = windows.get(event.sender)?.state();
    if (state?.kind !== 'hosting') {
      console.error('A page asked to copy a join code without sharing a plan.');
      return failure({ code: 'TASK_FAILED' });
    }
    try {
      await services.copyText(state.hosting.server.code());
    } catch (error) {
      console.error('The join code could not be copied:', error);
      return failure({ code: 'TASK_FAILED' });
    }
    return success(null);
  });
  handle(IPC_CHANNELS.openSharedPlan, (event, value) =>
    openShared(services, event.sender, windows.get(event.sender)?.state(), value),
  );
  handle(IPC_CHANNELS.findPlans, (event, searching) => {
    if (typeof searching !== 'boolean') {
      refuseMessage();
    }
    searches.get(event.sender)?.();
    searches.delete(event.sender);
    if (searching) {
      searches.set(
        event.sender,
        findPlans(sharedMdns(), (plans) => {
          tell(event.sender, { kind: 'nearbyPlans', plans: plans.map(nearbyPlanForPage) });
        }),
      );
    }
    return success(null);
  });
  /** Finds the connection of a guest of the plan a page hosts, logging a page that names a guest not connected. */
  const peerOf = (sender: WebContents, peer: unknown, logged: string): Peer | undefined => {
    const state = windows.get(sender)?.state();
    const known =
      state?.kind === 'hosting' && typeof peer === 'number'
        ? state.hosting.peers.get(peer)
        : undefined;
    if (known === undefined) {
      console.error(logged);
    }
    return known;
  };
  handle(IPC_CHANNELS.dropPeer, (event, peer) => {
    const known = peerOf(
      event.sender,
      peer,
      'The page asked to drop a guest that is not connected.',
    );
    if (known === undefined) {
      return failure({ code: 'TASK_FAILED' });
    }
    known.turnAway();
    return success(null);
  });
  handle(IPC_CHANNELS.forgetGuests, (event, ids) => {
    const forgotten = readParticipantIds(ids) ?? refuseMessage();
    const state = windows.get(event.sender)?.state();
    if (state?.kind !== 'hosting') {
      console.error('The page asked to forget guests without hosting a plan.');
      return failure({ code: 'TASK_FAILED' });
    }
    state.hosting.server.forget(forgotten);
    return success(null);
  });
  handle(IPC_CHANNELS.allowPeerToEdit, (event, peer) => {
    const known = peerOf(
      event.sender,
      peer,
      'The page asked to let a guest edit who is not connected.',
    );
    if (known === undefined) {
      return failure({ code: 'TASK_FAILED' });
    }
    known.allowEditing();
    return success(null);
  });
  ipcMain.on(
    IPC_CHANNELS.collaborationSend,
    (event: IpcMainEvent, to: unknown, message: unknown) => {
      services.assertTrusted(event);
      sendFrom(windows.get(event.sender)?.state(), to, message);
    },
  );
  return {
    forgetWindow: (sender) => {
      stopWindow(sender).catch((error: unknown) => {
        console.error('The sharing of a closing window could not be stopped:', error);
      });
    },
    isBusy: isBusyHere,
  };
}

/** Reads the settings of this computer, a store the system cannot read being logged and reported. */
async function readSettings(storePath: string): Promise<BridgeResult<CollaborationSettings>> {
  try {
    return success(await loadCollaborationSettings(storePath));
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The collaboration settings could not be read:', error);
    return failure({ code: 'READ_FAILED' });
  }
}

/** Writes the settings of this computer, a store the system cannot write being logged and reported. */
async function saveSettings(
  storePath: string,
  settings: CollaborationSettings,
): Promise<BridgeResult<null>> {
  try {
    await storeCollaborationSettings(storePath, settings);
    return success(null);
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The collaboration settings could not be written:', error);
    return failure({ code: 'WRITE_FAILED' });
  }
}

/** Reads the names a page shares a plan under, or null when they are not well-formed names of a plan and of a person. */
function readSharingNames(
  planName: unknown,
  hostName: unknown,
): { readonly planName: string; readonly hostName: string } | null {
  const issues = createIssueList();
  const plan = readText({ value: planName, path: 'planName' }, issues, MAX_PROJECT_NAME_LENGTH);
  const host = readText({ value: hostName, path: 'hostName' }, issues, MAX_PARTICIPANT_NAME_LENGTH);
  return plan === undefined || host === undefined ? null : { planName: plan, hostName: host };
}

/** Reads the queue of candidates a page gives to look for the next host, in order, each with its identifier, rank and where it could host, or null for any other shape. */
function readSuccessionQueue(value: unknown): readonly SuccessionCandidate[] | null {
  const issues = createIssueList();
  const items = readArray({ value, path: 'queue' }, issues, MAX_PARTICIPANTS);
  if (items === undefined) {
    return null;
  }
  const candidates = items.map((_item, index) =>
    readCandidate(itemField(items, index, 'queue'), issues),
  );
  const read = candidates.filter((candidate) => candidate !== undefined);
  return read.length === items.length && issues.issues.length === 0 ? read : null;
}

/** Reads the identifiers of guests the page no longer knows, a list of valid identifiers no longer than the people a host remembers. */
function readParticipantIds(value: unknown): readonly ParticipantId[] | null {
  return Array.isArray(value) &&
    value.length <= MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS &&
    value.every((id) => isParticipantId(id))
    ? value
    : null;
}

/** Reads the people of a plan a page gives, with the digest of their token, rank and right, which the next host checks the people coming back against, or null for any other shape. */
function readKnownPeople(value: unknown): readonly KnownPerson[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) {
    return null;
  }
  const entries = value.map(readKnownPerson);
  const valid = entries.filter((entry) => entry !== null);
  return valid.length === entries.length ? valid : null;
}

/** Reads one person of a plan a page gives: its identifier, the digest of its token, its rank and whether it may edit, or null for any other shape. */
function readKnownPerson(item: unknown): KnownPerson | null {
  const participantId: unknown = Reflect.get(Object(item), 'participantId');
  const tokenDigest: unknown = Reflect.get(Object(item), 'tokenDigest');
  const rank: unknown = Reflect.get(Object(item), 'rank');
  const canEdit: unknown = Reflect.get(Object(item), 'canEdit');
  const isRank = Number.isInteger(rank) && Number(rank) >= 0 && Number(rank) <= MAX_JOIN_RANK;
  return isParticipantId(participantId) &&
    isTokenDigest(tokenDigest) &&
    isRank &&
    typeof canEdit === 'boolean'
    ? { participantId, tokenDigest, rank: Number(rank), canEdit }
    : null;
}

/** Reads one candidate of the queue to the next host. */
function readCandidate(
  field: { readonly value: unknown; readonly path: string },
  issues: ReturnType<typeof createIssueList>,
): SuccessionCandidate | undefined {
  const record = readRecord(field, issues, CANDIDATE_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const participantId = identifierReader(isParticipantId)(
    childField(record, 'participantId', field.path),
    issues,
  );
  const rank = readInteger(childField(record, 'rank', field.path), issues, 0, MAX_JOIN_RANK);
  const endpoint = readNullable(childField(record, 'endpoint', field.path), issues, readEndpoint);
  return participantId === undefined || rank === undefined || endpoint === undefined
    ? undefined
    : { participantId, rank, endpoint };
}

/** Keeps of a plan heard nearby what the page shows. */
function nearbyPlanForPage(plan: HeardPlan): NearbyPlan {
  return {
    key: plan.key,
    planName: plan.planName,
    hostName: plan.hostName,
    addresses: plan.addresses,
    port: plan.port,
  };
}

/** Reads what a page asks to join: a host address and port as typed, checked later since a person may mistype them, a join code, a participant identifier and a name, or null. */
function readJoinRequest(value: unknown): CheckedJoinRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  /** Reads a field of the request, whatever its shape. */
  const field = (name: string): unknown => Reflect.get(value, name);
  const address = field('address');
  const port = field('port');
  const code = typeof field('code') === 'string' ? readJoinCode(String(field('code'))) : null;
  const participantId = field('participantId');
  const issues = createIssueList();
  const name = readText(
    { value: field('name'), path: 'name' },
    issues,
    MAX_PARTICIPANT_NAME_LENGTH,
  );
  const valid =
    typeof address === 'string' &&
    typeof port === 'number' &&
    code !== null &&
    isParticipantId(participantId) &&
    name !== undefined;
  return valid ? { address, port, code, participantId, name } : null;
}

/** Draws a short random name that keeps two plans announced from the same computer apart. */
function instanceName(randomBytes: (count: number) => Uint8Array): string {
  return [...randomBytes(INSTANCE_BYTES)]
    .map((byte) => byte.toString(HEX_BASE).padStart(HEX_DIGITS, '0'))
    .join('');
}

/** Checks in the worker the state of the plan a window joined, as the content of a file, and offers it to the window, refusing a window that joined nothing. */
async function openShared(
  services: CollaborationServices,
  sender: WebContents,
  sharing: WindowStateView | undefined,
  value: unknown,
): Promise<BridgeResult<OpenedProject>> {
  const state = readProjectState(value) ?? refuseMessage();
  if (sharing?.kind !== 'guest') {
    console.error('A page opened a shared plan without having joined one.');
    return failure({ code: 'TASK_FAILED' });
  }
  const loaded = await services.runTask({ kind: 'readSharedState', state });
  return loaded.ok ? success(offerSharedProject(sender, loaded.value)) : loaded;
}

/** Sends a message of the page to a guest or to the host, logging and dropping a message of another shape, since a one-way message has nobody to refuse it to, and logging one that cannot be sent. */
function sendFrom(sharing: WindowStateView | undefined, to: unknown, message: unknown): void {
  const isMessage =
    message instanceof Uint8Array && message.length <= MAX_COLLABORATION_MESSAGE_BYTES;
  if (!isMessage || !isTarget(to)) {
    console.error('The page sent a message of the shared plan of an unexpected shape.');
    return;
  }
  if (typeof to !== 'number' && to !== 'host') {
    sendToMany(sharing, to, message);
    return;
  }
  const sent = sendTo(sharing, to, message);
  if (sent !== null) {
    console.warn(`A message of the shared plan could not be sent: ${sent}.`);
  }
}

/** Tells whether the page named the host, one guest, or a few guests at most as many as a plan holds. */
function isTarget(to: unknown): to is CollaborationTarget {
  return (
    to === 'host' ||
    isPeer(to) ||
    (Array.isArray(to) && to.length <= MAX_PARTICIPANTS && to.every(isPeer))
  );
}

/** Tells whether a value numbers a guest connection. */
function isPeer(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Sends one message to several guests of the plan a window hosts, compressing it once and sealing it for each, logging a guest it could not reach. */
function sendToMany(
  sharing: WindowStateView | undefined,
  peers: readonly number[],
  message: Uint8Array,
): void {
  const compressed = compressMessage(message, 'plan', zlibCompressor);
  if (!compressed.ok) {
    console.warn(`A message of the shared plan could not be sent: ${compressed.error}.`);
    return;
  }
  for (const number of peers) {
    const peer = sharing?.kind === 'hosting' ? sharing.hosting.peers.get(number) : undefined;
    const sent = peer?.sendCompressed(compressed.value) ?? failure('NO_SUCH_PEER');
    if (!sent.ok) {
      console.warn(`A message of the shared plan could not be sent: ${sent.error}.`);
    }
  }
}

/** Sends a message to its target, giving why it could not be sent or null. */
function sendTo(
  sharing: WindowStateView | undefined,
  to: number | 'host',
  message: Uint8Array,
): string | null {
  if (sharing?.kind === 'guest' && to === 'host') {
    const sent = sharing.session.send(message);
    return sent.ok ? null : sent.error;
  }
  const peer =
    sharing?.kind === 'hosting' && to !== 'host' ? sharing.hosting.peers.get(to) : undefined;
  if (peer === undefined) {
    return 'NO_SUCH_PEER';
  }
  const sent = peer.send(message);
  return sent.ok ? null : sent.error;
}

/** Tells a page what happened to what it shares or joined, unless the page is gone. */
function tell(sender: WebContents, event: CollaborationEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.collaborationEvent, event);
  }
}
