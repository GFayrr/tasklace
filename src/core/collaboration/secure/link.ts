import { MAX_INTRODUCTION_BYTES, MAX_PARTICIPANT_NAME_LENGTH } from '../../limits';
import { failure, success, type Result } from '../../result';
import { createIssueList } from '../../validation/validation-issues';
import { childField, readIdentifier, readRecord, readText } from '../../validation/value-readers';
import { parsedJson } from '../messages';
import { isParticipantId, type ParticipantId } from '../participants';
import { SESSION_ID_BYTES, SHARE_BYTES, startHandshake, type SessionKeys } from './cpace';

export type LinkRefusal = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'INVALID_SHARE' | 'WRONG_CODE';

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
}

export const LINK_VERSION = 1;
export const PROOF_BYTES = 64;
export const HELLO_BYTES = 1 + SESSION_ID_BYTES + SHARE_BYTES;
export const REPLY_BYTES = SHARE_BYTES + PROOF_BYTES;

const INTRODUCTION_KEYS = ['participantId', 'name'];
const ENCODER = new TextEncoder();

/** Starts the opening of a connection on the side of the host: a hello with the version, a random session and the share of the host, the proof of the host being sent only once the guest proved it knows the code. */
export function startHostLink(code: string, randomBytes: (count: number) => Uint8Array): HostLink {
  const sessionId = randomBytes(SESSION_ID_BYTES);
  const handshake = startHandshake(code, sessionId, 'host', randomBytes);
  const hello = new Uint8Array(HELLO_BYTES);
  hello[0] = LINK_VERSION;
  hello.set(sessionId, 1);
  hello.set(handshake.share, 1 + SESSION_ID_BYTES);
  return {
    hello,
    answer: (reply) => {
      if (reply.length !== REPLY_BYTES) {
        return failure('MALFORMED');
      }
      const confirmation = handshake.answer(reply.subarray(0, SHARE_BYTES));
      if (!confirmation.ok) {
        return confirmation;
      }
      const keys = confirmation.value.check(reply.subarray(SHARE_BYTES));
      return keys.ok
        ? success({ confirm: confirmation.value.proof, keys: keys.value })
        : failure(keys.error);
    },
  };
}

/** Answers the hello of a host on the side of a guest with its share and its proof of the code, giving the keys once the proof of the host matches. */
export function answerHostLink(
  hello: Uint8Array,
  code: string,
  randomBytes: (count: number) => Uint8Array,
): Result<GuestLink, LinkRefusal> {
  if (hello.length !== HELLO_BYTES) {
    return failure('MALFORMED');
  }
  if (hello[0] !== LINK_VERSION) {
    return failure('UNSUPPORTED_VERSION');
  }
  const sessionId = hello.subarray(1, 1 + SESSION_ID_BYTES);
  const handshake = startHandshake(code, sessionId, 'guest', randomBytes);
  const confirmation = handshake.answer(hello.subarray(1 + SESSION_ID_BYTES));
  if (!confirmation.ok) {
    return confirmation;
  }
  const reply = new Uint8Array(REPLY_BYTES);
  reply.set(handshake.share);
  reply.set(confirmation.value.proof, SHARE_BYTES);
  return success({
    reply,
    finish: (confirm) => {
      if (confirm.length !== PROOF_BYTES) {
        return failure('MALFORMED');
      }
      return confirmation.value.check(confirm);
    },
  });
}

/** Writes the first message a guest sends once the channel is open: who it is and the name it shows. */
export function encodeIntroduction(introduction: Introduction): Uint8Array {
  return ENCODER.encode(JSON.stringify(introduction));
}

/** Reads the first message of a guest from untrusted bytes, refusing anything but a short record of an identifier of a participant and a well-formed name. */
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
  const participantId = readIdentifier(childField(record, 'participantId', ''), issues);
  const name = readText(childField(record, 'name', ''), issues, MAX_PARTICIPANT_NAME_LENGTH);
  return isParticipantId(participantId) && name !== undefined && issues.issues.length === 0
    ? { participantId, name }
    : null;
}
