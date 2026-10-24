import type { TokenDigest } from './secure/token-digest';
import { isIdentifierText } from '../identifiers';
import type { TaskId } from '../model/project';

declare const PARTICIPANT_ID: unique symbol;

export type ParticipantId = string & { readonly [PARTICIPANT_ID]: true };

export const PARTICIPANT_COLOR_COUNT = 8;

export interface Participant {
  readonly id: ParticipantId;
  readonly name: string;
  readonly color: number;
  readonly canEdit: boolean;
  readonly isHost: boolean;
  readonly rank: number;
  readonly selectedTaskId: TaskId | null;
  readonly endpoint: Endpoint | null;
  readonly tokenDigest: TokenDigest | null;
}

export interface Endpoint {
  readonly addresses: readonly string[];
  readonly port: number;
}

/** Tells whether a value can identify a participant of a shared plan, with the same characters as the identifiers of a project. */
export function isParticipantId(value: unknown): value is ParticipantId {
  return isIdentifierText(value);
}

/** Gives a value known to identify a participant, such as one the host just generated, as one, throwing for any other value since only a programming error can give one. */
export function requireParticipantId(value: unknown): ParticipantId {
  if (!isParticipantId(value)) {
    throw new TypeError(`Not a participant identifier: ${String(value)}`);
  }
  return value;
}
