import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join as joinPath } from 'node:path';
import type { IpcMainEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import { isParticipantId, requireParticipantId } from '../../core/collaboration/participants';
import { isPort } from '../../core/collaboration/ports';
import { readJoinCode } from '../../core/collaboration/secure/join-code';
import { drawRejoinToken } from '../../core/collaboration/secure/link';
import {
  MAX_COLLABORATION_MESSAGE_BYTES,
  MAX_PARTICIPANT_NAME_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
} from '../../core/limits';
import { failure, success } from '../../core/result';
import { createIssueList } from '../../core/validation/validation-issues';
import { readText } from '../../core/validation/value-readers';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type CollaborationEvent,
  type CollaborationSettings,
  type InvokeChannel,
  type JoinRequest,
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
import { announcePlan, findPlans, type Mdns } from './discovery';
import { connectAsGuest, isHostAddress } from './guest-client';
import { startGuestSession, type GuestSession } from './guest-session';
import { startHostServer, type HostServer, type Peer } from './host-server';
import { isPrivateAddress } from './private-addresses';
import type { StartTimer } from './secure-connection';

export interface CollaborationServices {
  readonly assertTrusted: TrustCheck;
  readonly userDataFolder: string;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly createMdns: () => { readonly mdns: Mdns; readonly destroy: () => void };
  readonly copyText: (text: string) => Promise<void>;
  readonly addresses?: () => readonly string[];
  readonly startTimer?: StartTimer;
}

export type WindowSharing =
  | {
      readonly kind: 'hosting';
      readonly server: HostServer;
      readonly peers: Map<number, Peer>;
      readonly stopAnnouncing: () => Promise<void>;
    }
  | { readonly kind: 'guest'; readonly client: GuestSession };

const SETTINGS_STORE = 'collaboration-settings.json';
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
  const sharings = new Map<WebContents, WindowSharing>();
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
  /** Stops what a window shares or joined, and its search for plans nearby. */
  const stopWindow = async (sender: WebContents): Promise<void> => {
    searches.get(sender)?.();
    searches.delete(sender);
    const sharing = sharings.get(sender);
    sharings.delete(sender);
    if (sharing?.kind === 'guest') {
      sharing.client.close();
    }
    if (sharing?.kind === 'hosting') {
      await sharing.stopAnnouncing();
      await sharing.server.close();
    }
    if (sharings.size === 0 && searches.size === 0) {
      mdns?.destroy();
      mdns = null;
    }
  };
  handle(IPC_CHANNELS.collaborationSettings, () => readSettings(storePath));
  handle(IPC_CHANNELS.saveCollaborationSettings, (_event, value) =>
    saveSettings(storePath, readCollaborationSettings(value) ?? refuseMessage()),
  );
  handle(IPC_CHANNELS.sharePlan, async (event, planName, hostName) => {
    const names = readSharingNames(planName, hostName) ?? refuseMessage();
    if (sharings.has(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    const sharing = await share(event.sender, names, { storePath, startTimer, sharedMdns });
    if (!sharing.ok) {
      return sharing;
    }
    sharings.set(event.sender, sharing.value);
    return success({
      code: sharing.value.server.code(),
      port: sharing.value.server.port,
      addresses: addresses(),
    });
  });
  handle(IPC_CHANNELS.stopCollaboration, async (event) => {
    await stopWindow(event.sender);
    return success(null);
  });
  handle(IPC_CHANNELS.joinPlan, (event, value) => {
    const request = readJoinRequest(value) ?? refuseMessage();
    if (!isHostAddress(request.address) || !isPort(request.port)) {
      return failure({ code: 'INVALID_ADDRESS' });
    }
    if (sharings.has(event.sender)) {
      return failure({ code: 'ALREADY_SHARING' });
    }
    startGuest(sharings, event.sender, (ended) =>
      joinHost(event.sender, request, startTimer, ended),
    );
    return success(null);
  });
  handle(IPC_CHANNELS.copyJoinCode, async (event) => {
    const sharing = sharings.get(event.sender);
    if (sharing?.kind !== 'hosting') {
      console.error('A page asked to copy a join code without sharing a plan.');
      return failure({ code: 'TASK_FAILED' });
    }
    try {
      await services.copyText(sharing.server.code());
    } catch (error) {
      console.error('The join code could not be copied:', error);
      return failure({ code: 'TASK_FAILED' });
    }
    return success(null);
  });
  handle(IPC_CHANNELS.openSharedPlan, (event, value) =>
    openShared(services, event.sender, sharings.get(event.sender), value),
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
          tell(event.sender, { kind: 'nearbyPlans', plans });
        }),
      );
    }
    return success(null);
  });
  handle(IPC_CHANNELS.dropPeer, (event, peer) => {
    const sharing = sharings.get(event.sender);
    const known =
      sharing?.kind === 'hosting' && typeof peer === 'number' ? sharing.peers.get(peer) : undefined;
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
      sendFrom(sharings.get(event.sender), to, message);
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

/** Starts the server of a window on the port of its settings, announces the plan nearby, and passes to the page who joins, what each guest sends, who leaves and each new code. */
async function share(
  sender: WebContents,
  names: { readonly planName: string; readonly hostName: string },
  context: {
    readonly storePath: string;
    readonly startTimer: StartTimer;
    readonly sharedMdns: () => Mdns;
  },
): Promise<BridgeResult<Extract<WindowSharing, { kind: 'hosting' }>>> {
  const settings = await readSettings(context.storePath);
  if (!settings.ok) {
    return settings;
  }
  const peers = new Map<number, Peer>();
  const started = await startHostServer({
    port: settings.value.port,
    planKey: null,
    startTimer: context.startTimer,
    randomBytes: systemRandomBytes,
    events: {
      joined: (peer, introduction) => {
        peers.set(peer.number, peer);
        tell(sender, {
          kind: 'peerJoined',
          peer: peer.number,
          participantId: introduction.participantId,
          name: introduction.name,
        });
      },
      message: (peer, message) => {
        tell(sender, { kind: 'peerMessage', peer: peer.number, message });
      },
      left: (peer) => {
        peers.delete(peer.number);
        tell(sender, { kind: 'peerLeft', peer: peer.number });
      },
      codeChanged: (code) => {
        tell(sender, { kind: 'codeChanged', code });
      },
    },
  });
  if (!started.ok) {
    return failure({ code: started.error });
  }
  const stopAnnouncing = announceSafely(context.sharedMdns, {
    instance: instanceName(),
    port: started.value.port,
    ...names,
  });
  return success({ kind: 'hosting', server: started.value, peers, stopAnnouncing });
}

/** Announces a plan nearby, a network that refuses mDNS being only logged since people can still type the address. */
function announceSafely(
  sharedMdns: () => Mdns,
  plan: Parameters<typeof announcePlan>[1],
): () => Promise<void> {
  try {
    return announcePlan(sharedMdns(), plan);
  } catch (error) {
    console.warn('The shared plan could not be announced on the network:', error);
    return () => Promise.resolve();
  }
}

/** Draws a short random name that keeps two plans announced from the same computer apart. */
function instanceName(): string {
  return [...systemRandomBytes(INSTANCE_BYTES)]
    .map((byte) => byte.toString(HEX_BASE).padStart(HEX_DIGITS, '0'))
    .join('');
}

/** Keeps the connection of a window to a host until it ends, so that the window can join again, a late end of an older connection leaving a newer one in place. */
export function startGuest(
  sharings: Map<WebContents, WindowSharing>,
  sender: WebContents,
  connect: (ended: () => void) => GuestSession,
): void {
  const connection: { client: GuestSession | null; hasEnded: boolean } = {
    client: null,
    hasEnded: false,
  };
  connection.client = connect(() => {
    connection.hasEnded = true;
    const current = sharings.get(sender);
    if (current?.kind === 'guest' && current.client === connection.client) {
      sharings.delete(sender);
    }
  });
  if (!connection.hasEnded) {
    sharings.set(sender, { kind: 'guest', client: connection.client });
  }
}

/** Joins a host for a window with a token of its own, passing to the page when the connection opens or is lost, what the host sends and why it ended for good, then telling the window ended. */
function joinHost(
  sender: WebContents,
  request: JoinRequest,
  startTimer: StartTimer,
  windowEnded: () => void,
): GuestSession {
  return startGuestSession({
    address: request.address,
    port: request.port,
    code: request.code,
    introduction: {
      participantId: requireParticipantId(request.participantId),
      name: request.name,
      token: drawRejoinToken(systemRandomBytes),
    },
    startTimer,
    connect: (options) => connectAsGuest({ ...options, randomBytes: systemRandomBytes }),
    tell: (event) => {
      tell(sender, event);
    },
    ended: windowEnded,
  });
}

/** Checks in the worker the state of the plan a window joined, as the content of a file, and offers it to the window, refusing a window that joined nothing. */
async function openShared(
  services: CollaborationServices,
  sender: WebContents,
  sharing: WindowSharing | undefined,
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
function sendFrom(sharing: WindowSharing | undefined, to: unknown, message: unknown): void {
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
  sharing: WindowSharing | undefined,
  to: number | 'host',
  message: Uint8Array,
): string | null {
  if (sharing?.kind === 'guest' && to === 'host') {
    const sent = sharing.client.send(message);
    return sent.ok ? null : sent.error;
  }
  const peer = sharing?.kind === 'hosting' && to !== 'host' ? sharing.peers.get(to) : undefined;
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
