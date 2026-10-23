import {
  MAX_COLLABORATION_MESSAGE_BYTES,
  MAX_JOIN_RANK,
  MAX_PARTICIPANT_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_ROSTER_MESSAGE_BYTES,
} from '../limits';
import type { TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { createIssueList, type IssueList } from '../validation/validation-issues';
import {
  childField,
  itemField,
  readArray,
  readBoolean,
  readIdentifier,
  readInteger,
  readNullable,
  readRecord,
  readText,
  type Field,
} from '../validation/value-readers';
import {
  PARTICIPANT_COLOR_COUNT,
  isParticipantId,
  type Participant,
  type ParticipantId,
} from './participants';
import { readEndpoint } from './endpoint';
import { isTokenDigest } from './secure/token-digest';

export type CollaborationMessage =
  | { readonly kind: 'stateVector'; readonly vector: Uint8Array }
  | { readonly kind: 'update'; readonly update: Uint8Array }
  | { readonly kind: 'presence'; readonly name: string; readonly selectedTaskId: TaskId | null }
  | {
      readonly kind: 'participants';
      readonly you: ParticipantId;
      readonly participants: readonly Participant[];
    }
  | { readonly kind: 'refused' };

export type MessageRefusal =
  'TOO_LARGE' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_KIND' | 'INVALID_CONTENT';

const MESSAGE_FORMAT_VERSION = 1;
const HEADER_BYTES = 2;
const KIND_CODES = {
  stateVector: 1,
  update: 2,
  presence: 3,
  participants: 4,
  refused: 5,
} as const satisfies Readonly<Record<CollaborationMessage['kind'], number>>;
const PRESENCE_KEYS = ['name', 'selectedTaskId'];
const PARTICIPANTS_KEYS = ['you', 'participants'];
const PARTICIPANT_KEYS = [
  'id',
  'name',
  'color',
  'canEdit',
  'isHost',
  'rank',
  'selectedTaskId',
  'endpoint',
  'tokenDigest',
];
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

/** Writes a message as bytes: the version of the format, its kind, then its content, raw for the states and updates of the shared document and as JSON for the others. */
export function encodeMessage(message: CollaborationMessage): Uint8Array {
  const content = contentOf(message);
  const bytes = new Uint8Array(HEADER_BYTES + content.length);
  bytes[0] = MESSAGE_FORMAT_VERSION;
  bytes[1] = KIND_CODES[message.kind];
  bytes.set(content, HEADER_BYTES);
  return bytes;
}

/** Returns the content of a message as bytes. */
function contentOf(message: CollaborationMessage): Uint8Array {
  switch (message.kind) {
    case 'stateVector':
      return message.vector;
    case 'update':
      return message.update;
    case 'presence':
      return ENCODER.encode(
        JSON.stringify({ name: message.name, selectedTaskId: message.selectedTaskId }),
      );
    case 'participants':
      return ENCODER.encode(
        JSON.stringify({ you: message.you, participants: message.participants }),
      );
    case 'refused':
      return new Uint8Array();
  }
}

/** Reads untrusted bytes received from the network as a message, refusing without ever throwing anything too large, of another version, of an unknown kind or whose content is not what its kind holds. */
export function readMessage(bytes: Uint8Array): Result<CollaborationMessage, MessageRefusal> {
  if (bytes.length > MAX_COLLABORATION_MESSAGE_BYTES) {
    return failure('TOO_LARGE');
  }
  if (bytes.length < HEADER_BYTES || bytes[0] !== MESSAGE_FORMAT_VERSION) {
    return failure('UNSUPPORTED_VERSION');
  }
  const content = bytes.slice(HEADER_BYTES);
  switch (bytes[1]) {
    case KIND_CODES.stateVector:
      return success({ kind: 'stateVector', vector: content });
    case KIND_CODES.update:
      return content.length === 0
        ? failure('INVALID_CONTENT')
        : success({ kind: 'update', update: content });
    case KIND_CODES.presence:
      return readJsonMessage(content, readPresence);
    case KIND_CODES.participants:
      return readJsonMessage(content, readParticipants);
    case KIND_CODES.refused:
      return content.length === 0 ? success({ kind: 'refused' }) : failure('INVALID_CONTENT');
    default:
      return failure('UNKNOWN_KIND');
  }
}

/** Reads the JSON content of a message within the size of a list of participants, refusing text that is not UTF-8 or JSON and content its reader refuses. */
function readJsonMessage(
  content: Uint8Array,
  read: (field: Field, issues: IssueList) => CollaborationMessage | undefined,
): Result<CollaborationMessage, MessageRefusal> {
  if (content.length > MAX_ROSTER_MESSAGE_BYTES) {
    return failure('TOO_LARGE');
  }
  const value = parsedJson(content);
  if (value === undefined) {
    return failure('INVALID_CONTENT');
  }
  const issues = createIssueList();
  const message = read({ value, path: '' }, issues);
  return message === undefined || issues.issues.length > 0
    ? failure('INVALID_CONTENT')
    : success(message);
}

/** Decodes UTF-8 JSON, or returns undefined when the bytes are not UTF-8 text or the text is not JSON. */
export function parsedJson(content: Uint8Array): unknown {
  try {
    return JSON.parse(DECODER.decode(content)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

/** Reads the presence a participant sends: its name and the task it has selected, if any. */
function readPresence(field: Field, issues: IssueList): CollaborationMessage | undefined {
  const record = readRecord(field, issues, PRESENCE_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const name = readText(childField(record, 'name', ''), issues, MAX_PARTICIPANT_NAME_LENGTH);
  const selectedTaskId = readNullable(
    childField(record, 'selectedTaskId', ''),
    issues,
    readIdentifier,
  );
  return name === undefined || selectedTaskId === undefined
    ? undefined
    : { kind: 'presence', name, selectedTaskId };
}

/** Reads the list of participants the host sends, with the one it is sent to, refusing a list without exactly one host, with an identifier or a rank twice, or that does not hold the receiver. */
function readParticipants(field: Field, issues: IssueList): CollaborationMessage | undefined {
  const record = readRecord(field, issues, PARTICIPANTS_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const you = childField(record, 'you', '').value;
  const items = readArray(childField(record, 'participants', ''), issues, MAX_PARTICIPANTS);
  if (!isParticipantId(you) || items === undefined) {
    return undefined;
  }
  const participants = items.map((_item, index) =>
    readParticipant(itemField(items, index, ''), issues),
  );
  if (participants.some((participant) => participant === undefined)) {
    return undefined;
  }
  const read = participants.filter((participant) => participant !== undefined);
  return isConsistentRoster(read, you)
    ? { kind: 'participants', you, participants: read }
    : undefined;
}

/** Tells whether a list of participants has exactly one host, each identifier and rank once, and holds the receiver. */
function isConsistentRoster(participants: readonly Participant[], you: ParticipantId): boolean {
  const ids = new Set(participants.map((participant) => participant.id));
  const ranks = new Set(participants.map((participant) => participant.rank));
  return (
    participants.filter((participant) => participant.isHost).length === 1 &&
    ids.size === participants.length &&
    ranks.size === participants.length &&
    ids.has(you)
  );
}

/** Reads one participant of the list the host sends. */
function readParticipant(field: Field, issues: IssueList): Participant | undefined {
  const record = readRecord(field, issues, PARTICIPANT_KEYS);
  if (record === undefined) {
    return undefined;
  }
  /** Reads a field of the participant under its key. */
  const child = (key: string): Field => childField(record, key, field.path);
  const id = child('id').value;
  const participant = {
    name: readText(child('name'), issues, MAX_PARTICIPANT_NAME_LENGTH),
    color: readInteger(child('color'), issues, 0, PARTICIPANT_COLOR_COUNT - 1),
    canEdit: readBoolean(child('canEdit'), issues),
    isHost: readBoolean(child('isHost'), issues),
    rank: readInteger(child('rank'), issues, 0, MAX_JOIN_RANK),
    selectedTaskId: readNullable(child('selectedTaskId'), issues, readIdentifier),
    endpoint: readNullable(child('endpoint'), issues, readEndpoint),
    tokenDigest: readNullable(child('tokenDigest'), issues, readTokenDigest),
  };
  const { name, color, canEdit, isHost, rank, selectedTaskId, endpoint, tokenDigest } = participant;
  if (
    !isParticipantId(id) ||
    name === undefined ||
    color === undefined ||
    canEdit === undefined ||
    isHost === undefined ||
    rank === undefined ||
    selectedTaskId === undefined ||
    endpoint === undefined ||
    tokenDigest === undefined
  ) {
    return undefined;
  }
  return { id, name, color, canEdit, isHost, rank, selectedTaskId, endpoint, tokenDigest };
}

/** Reads the digest of the token of a participant. */
function readTokenDigest(field: Field, issues: IssueList): string | undefined {
  if (isTokenDigest(field.value)) {
    return field.value;
  }
  issues.add(field.path, 'INVALID_IDENTIFIER');
  return undefined;
}
