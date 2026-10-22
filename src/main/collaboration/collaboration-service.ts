import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join as joinPath } from 'node:path';
import type { IpcMainEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import { readEndpoint } from '../../core/collaboration/endpoint';
import {
  isParticipantId,
  requireParticipantId,
  type ParticipantId,
} from '../../core/collaboration/participants';
import { isPort } from '../../core/collaboration/ports';
import { readJoinCode } from '../../core/collaboration/secure/join-code';
import { drawRejoinToken, type Introduction } from '../../core/collaboration/secure/link';
import { isTokenDigest } from '../../core/collaboration/secure/token-digest';
import {
  MAX_COLLABORATION_MESSAGE_BYTES,
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
  readIdentifier,
  readInteger,
  readNullable,
  readRecord,
  readText,
} from '../../core/validation/value-readers';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type CollaborationEvent,
  type CollaborationSettings,
  type InvokeChannel,
  type JoinRequest,
  type NearbyPlan,
  type OpenedProject,
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
import type { StartTimer } from './secure-connection';
import type { SuccessionCandidate } from './succession-driver';
import { createWindowSharing, type WindowSharing, type WindowState } from './window-sharing';

export interface CollaborationServices {
  readonly assertTrusted: TrustCheck;
  readonly userDataFolder: string;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly createMdns: () => { readonly mdns: Mdns; readonly destroy: () => void };
  readonly copyText: (text: string) => Promise<void>;
  readonly addresses?: () => readonly string[];
  readonly startTimer?: StartTimer;
}

const SETTINGS_STORE = 'collaboration-settings.json';
const CANDIDATE_KEYS = ['participantId', 'rank', 'endpoint'];
const INSTANCE_BYTES = 4;
const HEX_BASE = 16;
const HEX_DIGITS = 2;

/** Starts a timer with the clock of the system, returning how to stop it. */
const systemTimer: StartTimer = (milliseconds, onEnd) => {
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

/** Answers the collaboration requests of the bridge (settings, sharing, joining, the plan received, plans nearby), passing the encoded messages of each window without reading the plan, and returns how to stop a window that reloads or closes. */
export function registerCollaborationHandlers(services: CollaborationServices): {
  readonly forgetWindow: (sender: WebContents) => void;
} {
  const windows = new Map<WebContents, WindowSharing>();
  const searches = new Map<WebContents, () => void>();
  const storePath = joinPath(services.userDataFolder, SETTINGS_STORE);
  const startTimer = services.startTimer ?? systemTimer;
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
      mdns: sharedMdns,
      addresses,
      instance: instanceName,
    });
    windows.set(sender, created);
    return created;
  };
  /** Tells whether a window already shares, joined or looks for a host. */
  const isBusy = (sender: WebContents): boolean =>
    (windows.get(sender)?.state().kind ?? 'idle') !== 'idle';
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
      token: drawRejoinToken(systemRandomBytes),
      endpoint: {
        addresses: addresses().slice(0, MAX_ENDPOINT_ADDRESSES),
        port: settings.value.port,
      },
    });
  };
  /** Stops what a window shares or joined, and its search for plans nearby. */
  const stopWindow = async (sender: WebContents): Promise<void> => {
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
    const identity = await identityOf(id, names.hostName);
    if (!identity.ok) {
      return identity;
    }
    const hosted = await windowOf(event.sender).host(
      names,
      identity.value,
      identity.value.endpoint.port,
    );
    return hosted.ok ? hosted : failure({ code: hosted.error });
  });
  handle(IPC_CHANNELS.stopCollaboration, async (event) => {
    await stopWindow(event.sender);
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
    const identity = await identityOf(requireParticipantId(request.participantId), request.name);
    if (!identity.ok) {
      return identity;
    }
    windowOf(event.sender).join(request, identity.value);
    return success(null);
  });
  handle(IPC_CHANNELS.findNextHost, async (event, queue, planName, hostName, tokens) => {
    const candidates = readSuccessionQueue(queue) ?? refuseMessage();
    const names = readSharingNames(planName, hostName) ?? refuseMessage();
    const knownTokens = readKnownTokens(tokens) ?? refuseMessage();
    const settings = await readSettings(storePath);
    if (!settings.ok) {
      return settings;
    }
    if (!windowOf(event.sender).succeed(candidates, names, settings.value.port, knownTokens)) {
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
  handle(IPC_CHANNELS.dropPeer, (event, peer) => {
    const state = windows.get(event.sender)?.state();
    const known =
      state?.kind === 'hosting' && typeof peer === 'number'
        ? state.hosting.peers.get(peer)
        : undefined;
    if (known === undefined) {
      console.error('The page asked to drop a guest that is not connected.');
      return failure({ code: 'TASK_FAILED' });
    }
    known.remove();
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

/** Reads the digests of the tokens of the people of a plan a page gives, which the next host checks the people coming back against, or null for any other shape. */
function readKnownTokens(value: unknown): ReadonlyMap<string, string> | null {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) {
    return null;
  }
  const entries = value.map((item: unknown) => {
    const participantId: unknown = Reflect.get(Object(item), 'participantId');
    const tokenDigest: unknown = Reflect.get(Object(item), 'tokenDigest');
    return isParticipantId(participantId) && isTokenDigest(tokenDigest)
      ? ([participantId, tokenDigest] as const)
      : null;
  });
  const valid = entries.filter((entry) => entry !== null);
  return valid.length === entries.length ? new Map(valid) : null;
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
  const participantId = readIdentifier(childField(record, 'participantId', field.path), issues);
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
function readJoinRequest(value: unknown): JoinRequest | null {
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
function instanceName(): string {
  return [...systemRandomBytes(INSTANCE_BYTES)]
    .map((byte) => byte.toString(HEX_BASE).padStart(HEX_DIGITS, '0'))
    .join('');
}

/** Checks in the worker the state of the plan a window joined, as the content of a file, and offers it to the window, refusing a window that joined nothing. */
async function openShared(
  services: CollaborationServices,
  sender: WebContents,
  sharing: WindowState | undefined,
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
function sendFrom(sharing: WindowState | undefined, to: unknown, message: unknown): void {
  const isMessage =
    message instanceof Uint8Array && message.length <= MAX_COLLABORATION_MESSAGE_BYTES;
  const isTarget = to === 'host' || (typeof to === 'number' && Number.isInteger(to));
  if (!isMessage || !isTarget) {
    console.error('The page sent a message of the shared plan of an unexpected shape.');
    return;
  }
  const sent = sendTo(sharing, to, message);
  if (sent !== null) {
    console.warn(`A message of the shared plan could not be sent: ${sent}.`);
  }
}

/** Sends a message to its target, giving why it could not be sent or null. */
function sendTo(
  sharing: WindowState | undefined,
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
