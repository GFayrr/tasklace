import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Participant, ParticipantId } from './participants';
import { isOlder, type RankedId } from './roster';

export const SUCCESSION_TURN_MILLISECONDS = 15_000;
export const SHARING_ID_BYTES = 16;

const SHARING_ID_DOMAIN = new TextEncoder().encode('Tasklace sharing identifier v1');

/** Orders the participants allowed to edit, who may take over a plan whose host left, the one connected the longest first, the identifier deciding between equal ranks, so that every copy of the list gives the same order. */
export function successionQueue(participants: readonly Participant[]): readonly Participant[] {
  return participants
    .filter((participant) => !participant.isHost && participant.canEdit)
    .toSorted((first, second) => (isOlder(first, second) ? -1 : 1));
}

/** Gives how long a participant waits for an older one to host before hosting itself, one turn per participant before it in the queue, or null for someone not in it. */
export function hostingDelay(queue: readonly Participant[], me: ParticipantId): number | null {
  const place = queue.findIndex((participant) => participant.id === me);
  return place === -1 ? null : place * SUCCESSION_TURN_MILLISECONDS;
}

/** Tells whether a host must give way to another host of the same plan, the one connected the longest keeping its place. */
export function shouldYield(me: RankedId, other: RankedId): boolean {
  return isOlder(other, me);
}

/** Gives the identifier a host announces for its plan on the network: a digest of the key of the plan, which tells the people holding the key which announcement is theirs without revealing the key. */
export function sharingIdOf(planKey: Uint8Array): string {
  const input = new Uint8Array(SHARING_ID_DOMAIN.length + planKey.length);
  input.set(SHARING_ID_DOMAIN);
  input.set(planKey, SHARING_ID_DOMAIN.length);
  return bytesToHex(sha256(input).subarray(0, SHARING_ID_BYTES));
}
