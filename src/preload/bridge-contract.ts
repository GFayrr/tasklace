import type { Endpoint, ParticipantId } from '../core/collaboration/participants';
import type { OpenedPresence } from '../core/collaboration/relay/relay-envelope';
import type { ShownRelayLink } from '../core/collaboration/relay/relay-link';
import { RELAY_REFUSALS } from '../core/collaboration/relay/relay-wire';
import type { RelayDelivery, RelayOutgoing } from '../core/collaboration/relay/relay-member';
import type { JoinCode } from '../core/collaboration/secure/join-code';
import type { TokenDigest } from '../core/collaboration/secure/token-digest';
import type { CsvWarning } from '../core/exchange/csv/csv-rows';
import type { RegionalFormat } from '../core/exchange/csv/regional-format';
import type { FileError, StateCheckError } from '../core/file/tasklace-file';
import type { PrintDocument } from '../core/print/print-document';
import type { Result } from '../core/result';
import type { DocumentId } from '../core/shared/shared-document';
import type { ValidationIssue } from '../core/validation/validation-issues';

export const IPC_CHANNELS = {
  regionalFormat: 'system:regional-format',
  newProject: 'project:new',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  recentProjects: 'project:recent',
  importProject: 'project:import',
  saveProject: 'project:save',
  saveProjectAs: 'project:save-as',
  keepOwnChanges: 'project:keep-own-changes',
  openKeptChanges: 'project:open-kept-changes',
  setLocalCopyAside: 'project:set-local-copy-aside',
  exportProject: 'project:export',
  exportPdf: 'project:export-pdf',
  saveHeldPdf: 'project:save-held-pdf',
  exportLighterPdf: 'project:export-lighter-pdf',
  discardHeldPdf: 'project:discard-held-pdf',
  adoptProject: 'project:adopt',
  pageStartFailed: 'page:start-failed',
  flushRequested: 'project:flush-requested',
  flushDone: 'project:flush-done',
  collaborationSettings: 'collaboration:settings',
  saveCollaborationSettings: 'collaboration:save-settings',
  sharePlan: 'collaboration:share',
  stopCollaboration: 'collaboration:stop',
  joinPlan: 'collaboration:join',
  openSharedPlan: 'collaboration:open-shared',
  findPlans: 'collaboration:find-plans',
  dropPeer: 'collaboration:drop-peer',
  allowPeerToEdit: 'collaboration:allow-peer-to-edit',
  forgetGuests: 'collaboration:forget-guests',
  copyJoinCode: 'collaboration:copy-join-code',
  findNextHost: 'collaboration:find-next-host',
  collaborationSend: 'collaboration:send',
  collaborationEvent: 'collaboration:event',
  shareThroughRelay: 'relay:share',
  joinByLink: 'relay:join',
  reopenSharedPlan: 'relay:reopen',
  makeNewLinks: 'relay:new-links',
  forgetSharedPlan: 'relay:forget',
  copyRelayLink: 'relay:copy-link',
  openGuide: 'relay:open-guide',
  appVersion: 'app:version',
  openPrivacyPolicy: 'app:open-privacy-policy',
  updateSettings: 'updates:settings',
  setCheckForNewVersions: 'updates:set-check',
  checkAtLaunch: 'updates:check-at-launch',
  checkNow: 'updates:check-now',
  openReleasePage: 'updates:open-release-page',
  takeOutsideRequest: 'app:take-outside-request',
  outsideRequestReceived: 'app:outside-request',
  openOutsideFile: 'project:open-outside',
  setupState: 'setup:state',
  finishWelcome: 'setup:finish-welcome',
  setFileAssociation: 'setup:set-file-association',
  relaySend: 'relay:send',
} as const;

export type ExchangeKind = 'json' | 'csv';

export const RELEASE_CHECK_FAILURES = ['unreachable', 'refused', 'malformed'] as const;

export type ReleaseCheckFailure = (typeof RELEASE_CHECK_FAILURES)[number];

export type ReleaseCheck =
  | { readonly kind: 'latest' }
  | { readonly kind: 'newer'; readonly version: string }
  | { readonly kind: 'failed'; readonly reason: ReleaseCheckFailure };

export type LaunchCheck = ReleaseCheck | { readonly kind: 'skipped' };

export interface UpdateSettings {
  readonly checkForNewVersions: boolean;
}

export type OutsideRequest =
  { readonly kind: 'file' } | { readonly kind: 'link'; readonly link: string };

export type FileAssociation =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'thisCopy' }
  | { readonly kind: 'otherCopy'; readonly path: string };

export interface SetupState {
  readonly welcome: boolean;
  readonly association: FileAssociation;
}

export interface WelcomeChoices {
  readonly associate: boolean;
  readonly checkForNewVersions: boolean;
}

export type FileFailureCode =
  | FileError['code']
  | StateCheckError['code']
  | 'CANCELLED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'LOCAL_COPY_FAILED'
  | 'TOO_LARGE_TO_SAVE'
  | 'TOO_COMPLEX'
  | 'INVALID_ENCODING'
  | 'INVALID_IMPORT'
  | 'NO_PROJECT'
  | 'MISSING_CHARACTERS'
  | 'PRINT_FAILED'
  | 'PRINT_INCOMPLETE'
  | 'NO_FREE_PORT'
  | 'LISTEN_FAILED'
  | 'ALREADY_SHARING'
  | 'INVALID_ADDRESS'
  | 'NOT_SECURE'
  | 'INVALID_LINK'
  | 'LINK_UNREADABLE'
  | 'NOT_CONNECTED'
  | 'TASK_FAILED';

export const ISSUE_FAILURE_CODES = ['INVALID_PROJECT', 'INVALID_IMPORT', 'INVALID_STATE'] as const;

export type IssueFailureCode = (typeof ISSUE_FAILURE_CODES)[number];

export const RELAY_ENDS = [...RELAY_REFUSALS, 'CLOSED', 'UNREACHABLE', 'UNTRUSTED'] as const;

export type RelayEndReason = (typeof RELAY_ENDS)[number];

export type FileFailure =
  | { readonly code: IssueFailureCode; readonly issues: readonly ValidationIssue[] }
  | { readonly code: Exclude<FileFailureCode, IssueFailureCode> }
  | { readonly code: 'RELAY_ENDED'; readonly reason: RelayEndReason };

export type BridgeResult<T> = Result<T, FileFailure>;

export type ImportWarning = CsvWarning;

export interface OpenedProject {
  readonly state: Uint8Array;
  readonly documentId: DocumentId;
  readonly fileName: string;
  readonly warnings: readonly ImportWarning[];
  readonly localChanges: Uint8Array | null;
}

export interface SavedProject {
  readonly localCopySaved: boolean;
}

export interface ExportedFile {
  readonly fileName: string;
}

export type PdfExport =
  | { readonly kind: 'exported'; readonly fileName: string }
  | { readonly kind: 'heavy'; readonly bytes: number; readonly pages: number };

export interface RecentProject {
  readonly name: string;
  readonly folder: string;
  readonly relay: string | null;
}

export interface CollaborationSettings {
  readonly name: string | null;
  readonly port: number;
  readonly firewallNoticeSeen: boolean;
  readonly relayAddress: string | null;
}

export interface Sharing {
  readonly code: JoinCode;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly tokenDigest: TokenDigest;
}

export interface ShownRelayLinks {
  readonly edit: ShownRelayLink | null;
  readonly view: ShownRelayLink;
}

export type RelayLinkKind = 'edit' | 'view';

export interface RelayLinks {
  readonly shown: ShownRelayLinks;
  readonly relay: string;
  readonly kept: boolean;
}

export interface RelayJoined {
  readonly project: OpenedProject;
  readonly shown: ShownRelayLinks;
  readonly relay: string;
  readonly bytesSinceSnapshot: number;
  readonly kept: boolean;
}

export interface RelayReopened {
  readonly shown: ShownRelayLinks;
  readonly relay: string;
}

export interface KnownPerson {
  readonly participantId: ParticipantId;
  readonly tokenDigest: TokenDigest;
  readonly rank: number;
  readonly canEdit: boolean;
}

export interface JoinRequest {
  readonly address: string;
  readonly port: number;
  readonly code: string;
  readonly participantId: string;
  readonly name: string;
}

export interface NextHostCandidate {
  readonly participantId: ParticipantId;
  readonly rank: number;
  readonly endpoint: Endpoint | null;
}

export interface NearbyPlan {
  readonly key: string;
  readonly planName: string;
  readonly hostName: string;
  readonly addresses: readonly string[];
  readonly port: number;
}

export const GUEST_ENDS = [
  'MALFORMED',
  'UNSUPPORTED_VERSION',
  'INVALID_SHARE',
  'WRONG_CODE',
  'CODE_REPLACED',
  'WRONG_KEY',
  'IDENTITY_TAKEN',
  'TURNED_AWAY',
  'TRY_LATER',
  'HOST_LEFT',
  'TAMPERED',
  'TOO_LARGE',
  'INVALID_CONTENT',
  'WORN_OUT',
  'BROKEN',
  'TIMEOUT',
  'INVALID_INTRODUCTION',
  'WIRE_CLOSED',
  'CLOSED',
  'UNREACHABLE',
  'NOT_PRIVATE',
] as const;

export type GuestEndReason = (typeof GUEST_ENDS)[number];

export type CollaborationEvent =
  | {
      readonly kind: 'peerJoined';
      readonly peer: number;
      readonly participantId: ParticipantId;
      readonly name: string;
      readonly endpoint: Endpoint;
      readonly tokenDigest: TokenDigest;
    }
  | { readonly kind: 'peerMessage'; readonly peer: number; readonly message: Uint8Array }
  | { readonly kind: 'peerLeft'; readonly peer: number }
  | { readonly kind: 'codeChanged'; readonly code: JoinCode }
  | { readonly kind: 'nearbyPlans'; readonly plans: readonly NearbyPlan[] }
  | { readonly kind: 'connected' }
  | { readonly kind: 'hostMessage'; readonly message: Uint8Array }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'hostLeft' }
  | { readonly kind: 'becameHost'; readonly sharing: Sharing }
  | { readonly kind: 'yielded' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'ended'; readonly reason: GuestEndReason }
  | {
      readonly kind: 'relayConnected';
      readonly member: number;
      readonly members: readonly number[];
    }
  | {
      readonly kind: 'relayState';
      readonly state: Uint8Array | null;
      readonly bytesSinceSnapshot: number;
    }
  | { readonly kind: 'relayDelivery'; readonly delivery: RelayDelivery }
  | { readonly kind: 'relayCaughtUp' }
  | { readonly kind: 'relayPresence'; readonly member: number; readonly presence: OpenedPresence }
  | { readonly kind: 'relayJoined' | 'relayLeft'; readonly member: number }
  | { readonly kind: 'relayEnded'; readonly reason: RelayEndReason };

export type CollaborationTarget = number | readonly number[] | 'host';

export interface TasklaceBridge {
  readonly regionalFormat: () => Promise<RegionalFormat>;
  readonly newProject: () => Promise<string>;
  readonly openProject: () => Promise<BridgeResult<OpenedProject>>;
  readonly openRecentProject: (index: number) => Promise<BridgeResult<OpenedProject>>;
  readonly recentProjects: () => Promise<BridgeResult<readonly RecentProject[]>>;
  readonly importProject: (kind: ExchangeKind) => Promise<BridgeResult<OpenedProject>>;
  readonly adoptProject: (documentId: DocumentId) => Promise<BridgeResult<null>>;
  readonly saveProject: (state: Uint8Array) => Promise<BridgeResult<SavedProject>>;
  readonly keepOwnChanges: (
    state: Uint8Array,
    planName: string,
  ) => Promise<BridgeResult<SavedProject>>;
  readonly openKeptChanges: () => Promise<BridgeResult<OpenedProject>>;
  readonly setLocalCopyAside: (documentId: DocumentId) => Promise<BridgeResult<null>>;
  readonly saveProjectAs: (
    state: Uint8Array,
    suggestedName: string,
  ) => Promise<BridgeResult<SavedProject>>;
  readonly exportProject: (
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ) => Promise<BridgeResult<ExportedFile>>;
  readonly exportPdf: (
    document: PrintDocument,
    suggestedName: string,
  ) => Promise<BridgeResult<PdfExport>>;
  readonly saveHeldPdf: () => Promise<BridgeResult<ExportedFile>>;
  readonly exportLighterPdf: () => Promise<BridgeResult<ExportedFile>>;
  readonly discardHeldPdf: () => Promise<BridgeResult<null>>;
  readonly collaborationSettings: () => Promise<BridgeResult<CollaborationSettings>>;
  readonly saveCollaborationSettings: (
    settings: CollaborationSettings,
  ) => Promise<BridgeResult<null>>;
  readonly sharePlan: (
    planName: string,
    hostName: string,
    participantId: string,
  ) => Promise<BridgeResult<Sharing>>;
  readonly stopCollaboration: () => Promise<BridgeResult<null>>;
  readonly joinPlan: (request: JoinRequest) => Promise<BridgeResult<null>>;
  readonly openSharedPlan: (state: Uint8Array) => Promise<BridgeResult<OpenedProject>>;
  readonly findPlans: (searching: boolean) => Promise<BridgeResult<null>>;
  readonly dropPeer: (peer: number) => Promise<BridgeResult<null>>;
  readonly allowPeerToEdit: (peer: number) => Promise<BridgeResult<null>>;
  readonly forgetGuests: (participantIds: readonly string[]) => Promise<BridgeResult<null>>;
  readonly copyJoinCode: () => Promise<BridgeResult<null>>;
  readonly findNextHost: (
    queue: readonly NextHostCandidate[],
    planName: string,
    hostName: string,
    knownPeople: readonly KnownPerson[],
  ) => Promise<BridgeResult<null>>;
  readonly shareThroughRelay: (address: string) => Promise<BridgeResult<RelayLinks>>;
  readonly joinByLink: (link: string) => Promise<BridgeResult<RelayJoined>>;
  readonly reopenSharedPlan: (
    documentId: DocumentId,
  ) => Promise<BridgeResult<RelayReopened | null>>;
  readonly makeNewLinks: () => Promise<BridgeResult<RelayLinks>>;
  readonly forgetSharedPlan: () => Promise<BridgeResult<null>>;
  readonly copyRelayLink: (kind: RelayLinkKind) => Promise<BridgeResult<null>>;
  readonly openGuide: () => Promise<BridgeResult<null>>;
  readonly appVersion: () => Promise<BridgeResult<string>>;
  readonly openPrivacyPolicy: () => Promise<BridgeResult<null>>;
  readonly updateSettings: () => Promise<BridgeResult<UpdateSettings>>;
  readonly setCheckForNewVersions: (check: boolean) => Promise<BridgeResult<null>>;
  readonly checkAtLaunch: () => Promise<BridgeResult<LaunchCheck>>;
  readonly checkNow: () => Promise<BridgeResult<ReleaseCheck>>;
  readonly openReleasePage: (version: string) => Promise<BridgeResult<null>>;
  readonly takeOutsideRequest: () => Promise<BridgeResult<OutsideRequest | null>>;
  readonly openOutsideFile: () => Promise<BridgeResult<OpenedProject>>;
  readonly setupState: () => Promise<BridgeResult<SetupState>>;
  readonly finishWelcome: (choices: WelcomeChoices) => Promise<BridgeResult<FileAssociation>>;
  readonly setFileAssociation: (on: boolean) => Promise<BridgeResult<FileAssociation>>;
  readonly onOutsideRequest: (listener: () => void) => void;
  readonly sendToRelay: (outgoing: RelayOutgoing) => void;
  readonly sendToCollaboration: (to: CollaborationTarget, message: Uint8Array) => void;
  readonly onCollaborationEvent: (listener: (event: CollaborationEvent) => void) => void;
  readonly onFlushRequested: (flush: () => Promise<boolean>) => void;
  readonly reportStartFailure: () => void;
}

export interface ChannelAnswers {
  readonly [IPC_CHANNELS.regionalFormat]: RegionalFormat;
  readonly [IPC_CHANNELS.newProject]: string;
  readonly [IPC_CHANNELS.openProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.openRecentProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.recentProjects]: BridgeResult<readonly RecentProject[]>;
  readonly [IPC_CHANNELS.importProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.adoptProject]: BridgeResult<null>;
  readonly [IPC_CHANNELS.saveProject]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.saveProjectAs]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.keepOwnChanges]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.openKeptChanges]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.setLocalCopyAside]: BridgeResult<null>;
  readonly [IPC_CHANNELS.exportProject]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportPdf]: BridgeResult<PdfExport>;
  readonly [IPC_CHANNELS.saveHeldPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportLighterPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.discardHeldPdf]: BridgeResult<null>;
  readonly [IPC_CHANNELS.collaborationSettings]: BridgeResult<CollaborationSettings>;
  readonly [IPC_CHANNELS.saveCollaborationSettings]: BridgeResult<null>;
  readonly [IPC_CHANNELS.sharePlan]: BridgeResult<Sharing>;
  readonly [IPC_CHANNELS.stopCollaboration]: BridgeResult<null>;
  readonly [IPC_CHANNELS.joinPlan]: BridgeResult<null>;
  readonly [IPC_CHANNELS.openSharedPlan]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.findPlans]: BridgeResult<null>;
  readonly [IPC_CHANNELS.dropPeer]: BridgeResult<null>;
  readonly [IPC_CHANNELS.allowPeerToEdit]: BridgeResult<null>;
  readonly [IPC_CHANNELS.forgetGuests]: BridgeResult<null>;
  readonly [IPC_CHANNELS.copyJoinCode]: BridgeResult<null>;
  readonly [IPC_CHANNELS.findNextHost]: BridgeResult<null>;
  readonly [IPC_CHANNELS.shareThroughRelay]: BridgeResult<RelayLinks>;
  readonly [IPC_CHANNELS.joinByLink]: BridgeResult<RelayJoined>;
  readonly [IPC_CHANNELS.reopenSharedPlan]: BridgeResult<RelayReopened | null>;
  readonly [IPC_CHANNELS.makeNewLinks]: BridgeResult<RelayLinks>;
  readonly [IPC_CHANNELS.forgetSharedPlan]: BridgeResult<null>;
  readonly [IPC_CHANNELS.copyRelayLink]: BridgeResult<null>;
  readonly [IPC_CHANNELS.openGuide]: BridgeResult<null>;
  readonly [IPC_CHANNELS.appVersion]: BridgeResult<string>;
  readonly [IPC_CHANNELS.openPrivacyPolicy]: BridgeResult<null>;
  readonly [IPC_CHANNELS.updateSettings]: BridgeResult<UpdateSettings>;
  readonly [IPC_CHANNELS.setCheckForNewVersions]: BridgeResult<null>;
  readonly [IPC_CHANNELS.checkAtLaunch]: BridgeResult<LaunchCheck>;
  readonly [IPC_CHANNELS.checkNow]: BridgeResult<ReleaseCheck>;
  readonly [IPC_CHANNELS.openReleasePage]: BridgeResult<null>;
  readonly [IPC_CHANNELS.takeOutsideRequest]: BridgeResult<OutsideRequest | null>;
  readonly [IPC_CHANNELS.openOutsideFile]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.setupState]: BridgeResult<SetupState>;
  readonly [IPC_CHANNELS.finishWelcome]: BridgeResult<FileAssociation>;
  readonly [IPC_CHANNELS.setFileAssociation]: BridgeResult<FileAssociation>;
}

export interface ChannelArguments {
  readonly [IPC_CHANNELS.regionalFormat]: readonly [];
  readonly [IPC_CHANNELS.newProject]: readonly [];
  readonly [IPC_CHANNELS.openProject]: readonly [];
  readonly [IPC_CHANNELS.openRecentProject]: readonly [index: number];
  readonly [IPC_CHANNELS.recentProjects]: readonly [];
  readonly [IPC_CHANNELS.importProject]: readonly [kind: ExchangeKind];
  readonly [IPC_CHANNELS.adoptProject]: readonly [documentId: DocumentId];
  readonly [IPC_CHANNELS.saveProject]: readonly [state: Uint8Array];
  readonly [IPC_CHANNELS.saveProjectAs]: readonly [state: Uint8Array, suggestedName: string];
  readonly [IPC_CHANNELS.keepOwnChanges]: readonly [state: Uint8Array, planName: string];
  readonly [IPC_CHANNELS.openKeptChanges]: readonly [];
  readonly [IPC_CHANNELS.setLocalCopyAside]: readonly [documentId: DocumentId];
  readonly [IPC_CHANNELS.exportProject]: readonly [
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ];
  readonly [IPC_CHANNELS.exportPdf]: readonly [document: PrintDocument, suggestedName: string];
  readonly [IPC_CHANNELS.saveHeldPdf]: readonly [];
  readonly [IPC_CHANNELS.exportLighterPdf]: readonly [];
  readonly [IPC_CHANNELS.discardHeldPdf]: readonly [];
  readonly [IPC_CHANNELS.collaborationSettings]: readonly [];
  readonly [IPC_CHANNELS.saveCollaborationSettings]: readonly [settings: CollaborationSettings];
  readonly [IPC_CHANNELS.sharePlan]: readonly [
    planName: string,
    hostName: string,
    participantId: string,
  ];
  readonly [IPC_CHANNELS.stopCollaboration]: readonly [];
  readonly [IPC_CHANNELS.joinPlan]: readonly [request: JoinRequest];
  readonly [IPC_CHANNELS.openSharedPlan]: readonly [state: Uint8Array];
  readonly [IPC_CHANNELS.findPlans]: readonly [searching: boolean];
  readonly [IPC_CHANNELS.dropPeer]: readonly [peer: number];
  readonly [IPC_CHANNELS.allowPeerToEdit]: readonly [peer: number];
  readonly [IPC_CHANNELS.forgetGuests]: readonly [participantIds: readonly string[]];
  readonly [IPC_CHANNELS.copyJoinCode]: readonly [];
  readonly [IPC_CHANNELS.findNextHost]: readonly [
    queue: readonly NextHostCandidate[],
    planName: string,
    hostName: string,
    knownPeople: readonly KnownPerson[],
  ];
  readonly [IPC_CHANNELS.shareThroughRelay]: readonly [address: string];
  readonly [IPC_CHANNELS.joinByLink]: readonly [link: string];
  readonly [IPC_CHANNELS.reopenSharedPlan]: readonly [documentId: DocumentId];
  readonly [IPC_CHANNELS.makeNewLinks]: readonly [];
  readonly [IPC_CHANNELS.forgetSharedPlan]: readonly [];
  readonly [IPC_CHANNELS.copyRelayLink]: readonly [kind: RelayLinkKind];
  readonly [IPC_CHANNELS.openGuide]: readonly [];
  readonly [IPC_CHANNELS.appVersion]: readonly [];
  readonly [IPC_CHANNELS.openPrivacyPolicy]: readonly [];
  readonly [IPC_CHANNELS.updateSettings]: readonly [];
  readonly [IPC_CHANNELS.setCheckForNewVersions]: readonly [check: boolean];
  readonly [IPC_CHANNELS.checkAtLaunch]: readonly [];
  readonly [IPC_CHANNELS.checkNow]: readonly [];
  readonly [IPC_CHANNELS.openReleasePage]: readonly [version: string];
  readonly [IPC_CHANNELS.takeOutsideRequest]: readonly [];
  readonly [IPC_CHANNELS.openOutsideFile]: readonly [];
  readonly [IPC_CHANNELS.setupState]: readonly [];
  readonly [IPC_CHANNELS.finishWelcome]: readonly [choices: WelcomeChoices];
  readonly [IPC_CHANNELS.setFileAssociation]: readonly [on: boolean];
}

export type InvokeChannel = keyof ChannelAnswers & keyof ChannelArguments;
export type ResultChannel = {
  [C in InvokeChannel]: ChannelAnswers[C] extends BridgeResult<unknown> ? C : never;
}[InvokeChannel];

export const BRIDGE_NAME = 'tasklace';
