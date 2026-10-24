import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_INTRODUCTION_BYTES, MAX_PARTICIPANT_NAME_LENGTH } from '../../limits';
import { failure, success, type Result } from '../../result';
import { createIssueList } from '../../validation/validation-issues';
import { childField, identifierReader, readRecord, readText } from '../../validation/value-readers';
import { parsedJson } from '../messages';
import { readEndpoint } from '../endpoint';
import { isParticipantId, type Endpoint, type ParticipantId } from '../participants';
import { SESSION_ID_BYTES, SHARE_BYTES, startHandshake, type SessionKeys } from './cpace';
import type { JoinCode } from './join-code';
import { requireTokenDigest, type TokenDigest } from './token-digest';

export type LinkRefusal =
  'MALFORMED' | 'UNSUPPORTED_VERSION' | 'INVALID_SHARE' | 'WRONG_CODE' | 'WRONG_KEY';

declare const PLAN_KEY_BRAND: unique symbol;
declare const REJOIN_TOKEN_BRAND: unique symbol;

export type PlanKey = Uint8Array & { readonly [PLAN_KEY_BRAND]: true };

export type RejoinToken = string & { readonly [REJOIN_TOKEN_BRAND]: true };

export type JoinSecret =
  | { readonly kind: 'code'; readonly code: JoinCode }
  | { readonly kind: 'key'; readonly key: PlanKey };

export interface HostSecrets {
  readonly code: JoinCode;
  readonly planKey: PlanKey;
}

export interface HostLink {
  readonly hello: Uint8Array;
  readonly answer: (
    reply: Uint8Array,
  ) => Result<{ readonly confirm: Uint8Array; readonly keys: SessionKeys }, LinkRefusal>;
}

export interface GuestLink {
  readonly reply: Uint8Array;
  readonly finish: (confirm: Uint8Array) => Result<SessionKeys, LinkRefusal>;
}

export interface Introduction {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly token: RejoinToken;
  readonly endpoint: Endpoint;
}

export const LINK_VERSION = 1;
export const PROOF_BYTES = 64;
export const PLAN_KEY_BYTES = 32;
export const REJOIN_TOKEN_BYTES = 32;
export const HELLO_BYTES = 1 + SESSION_ID_BYTES + SHARE_BYTES + SHARE_BYTES;
export const REPLY_BYTES = 1 + SHARE_BYTES + PROOF_BYTES;

const CODE_MODE = 0;
const KEY_MODE = 1;
const KEY_PASSWORD_PREFIX = 'key:';
const CODE_SHARE_OFFSET = 1 + SESSION_ID_BYTES;
const KEY_SHARE_OFFSET = CODE_SHARE_OFFSET + SHARE_BYTES;
const INTRODUCTION_KEYS = ['participantId', 'name', 'token', 'endpoint'];
const HEX_DIGITS_PER_BYTE = 2;
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${String(REJOIN_TOKEN_BYTES * HEX_DIGITS_PER_BYTE)}}$`);
const ENCODER = new TextEncoder();

/** Starts the opening of a connection on the side of the host: a hello with the version, a random session and a share from the join code and one from the key of the plan, its proof sent only once the guest proved its secret. */
export function startHostLink(
  secrets: HostSecrets,
  randomBytes: (count: number) => Uint8Array,
): HostLink {
  const sessionId = randomBytes(SESSION_ID_BYTES);
  const byCode = startHandshake(secrets.code, sessionId, 'host', randomBytes);
  const byKey = startHandshake(keyPassword(secrets.planKey), sessionId, 'host', randomBytes);
  const hello = new Uint8Array(HELLO_BYTES);
  hello[0] = LINK_VERSION;
  hello.set(sessionId, 1);
  hello.set(byCode.share, CODE_SHARE_OFFSET);
  hello.set(byKey.share, KEY_SHARE_OFFSET);
  return {
    hello,
    answer: (reply) => {
      const mode = reply[0];
      if (reply.length !== REPLY_BYTES || (mode !== CODE_MODE && mode !== KEY_MODE)) {
        return failure('MALFORMED');
      }
      const handshake = mode === KEY_MODE ? byKey : byCode;
      const confirmation = handshake.answer(reply.subarray(1, 1 + SHARE_BYTES));
      if (!confirmation.ok) {
        return confirmation;
      }
      const keys = confirmation.value.check(reply.subarray(1 + SHARE_BYTES));
      if (!keys.ok) {
        return failure(mode === KEY_MODE ? 'WRONG_KEY' : keys.error);
      }
      return success({ confirm: confirmation.value.proof, keys: keys.value });
    },
  };
}

/** Gives the password a key of a plan stands for in the exchange of keys, which can never be a join code since a code has no colon. */
function keyPassword(key: Uint8Array): string {
  return `${KEY_PASSWORD_PREFIX}${bytesToHex(key)}`;
}

/** Answers the hello of a host on the side of a guest with the secret it holds, the join code or the key of the plan, its share and its proof, giving the keys once the proof of the host matches. */
export function answerHostLink(
  hello: Uint8Array,
  secret: JoinSecret,
  randomBytes: (count: number) => Uint8Array,
): Result<GuestLink, LinkRefusal> {
  if (hello.length !== HELLO_BYTES) {
    return failure('MALFORMED');
  }
  if (hello[0] !== LINK_VERSION) {
    return failure('UNSUPPORTED_VERSION');
  }
  const sessionId = hello.subarray(1, CODE_SHARE_OFFSET);
  const byKey = secret.kind === 'key';
  const password = byKey ? keyPassword(secret.key) : secret.code;
  const handshake = startHandshake(password, sessionId, 'guest', randomBytes);
  const offset = byKey ? KEY_SHARE_OFFSET : CODE_SHARE_OFFSET;
  const confirmation = handshake.answer(hello.subarray(offset, offset + SHARE_BYTES));
  if (!confirmation.ok) {
    return confirmation;
  }
  const reply = new Uint8Array(REPLY_BYTES);
  reply[0] = byKey ? KEY_MODE : CODE_MODE;
  reply.set(handshake.share, 1);
  reply.set(confirmation.value.proof, 1 + SHARE_BYTES);
  return success({
    reply,
    finish: (confirm) => {
      if (confirm.length !== PROOF_BYTES) {
        return failure('MALFORMED');
      }
      const keys = confirmation.value.check(confirm);
      return keys.ok || !byKey ? keys : failure('WRONG_KEY');
    },
  });
}

/** Draws the token a guest shows each time it joins, so that the host knows it is the same person, written as hexadecimal digits. */
export function drawRejoinToken(randomBytes: (count: number) => Uint8Array): RejoinToken {
  return requireRejoinToken(bytesToHex(randomBytes(REJOIN_TOKEN_BYTES)));
}

/** Tells whether a value is a token a guest shows when it comes back: sixty-four lowercase hexadecimal digits. */
export function isRejoinToken(value: unknown): value is RejoinToken {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** Gives a value known to be a token, such as one just drawn, as one, throwing for any other value since only a programming error can give one. */
export function requireRejoinToken(value: unknown): RejoinToken {
  if (!isRejoinToken(value)) {
    throw new TypeError(`Not a token: ${String(value)}`);
  }
  return value;
}

/** Draws the key of a shared plan, given to every person let in. */
export function drawPlanKey(randomBytes: (count: number) => Uint8Array): PlanKey {
  const key = readPlanKey(randomBytes(PLAN_KEY_BYTES));
  if (key === null) {
    throw new RangeError('The random source did not give the length of a key.');
  }
  return key;
}

/** Reads the key of a shared plan from bytes, or returns null when they do not have its length. */
export function readPlanKey(bytes: Uint8Array): PlanKey | null {
  return isPlanKey(bytes) ? bytes : null;
}

/** Tells whether bytes have the length of the key of a shared plan. */
function isPlanKey(bytes: Uint8Array): bytes is PlanKey {
  return bytes.length === PLAN_KEY_BYTES;
}

/** Gives the digest of the token of a guest, which the list of people carries so that a host taking over knows who may come back under an identifier, without the token itself. */
export function tokenDigestOf(token: RejoinToken): TokenDigest {
  return requireTokenDigest(bytesToHex(sha256(ENCODER.encode(token))));
}

/** Writes the first message a guest sends once the channel is open: who it is, the name it shows, the token that proves it is the same person when it comes back and where it could host the plan. */
export function encodeIntroduction(introduction: Introduction): Uint8Array {
  return ENCODER.encode(JSON.stringify(introduction));
}

/** Reads the first message of a guest from untrusted bytes, refusing anything but a short record of an identifier of a participant, a well-formed name, a token of hexadecimal digits and an endpoint. */
export function readIntroduction(bytes: Uint8Array): Introduction | null {
  if (bytes.length > MAX_INTRODUCTION_BYTES) {
    return null;
  }
  const value = parsedJson(bytes);
  const issues = createIssueList();
  const record = readRecord({ value, path: '' }, issues, INTRODUCTION_KEYS);
  if (record === undefined) {
    return null;
  }
  const participantId = identifierReader(isParticipantId)(
    childField(record, 'participantId', ''),
    issues,
  );
  const name = readText(childField(record, 'name', ''), issues, MAX_PARTICIPANT_NAME_LENGTH);
  const token = record['token'];
  const endpoint = readEndpoint(childField(record, 'endpoint', ''), issues);
  if (
    participantId === undefined ||
    name === undefined ||
    !isRejoinToken(token) ||
    endpoint === undefined ||
    issues.issues.length > 0
  ) {
    return null;
  }
  return { participantId, name, token, endpoint };
}
