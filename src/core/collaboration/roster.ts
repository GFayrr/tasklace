import { compareStrings } from '../compare-strings';
import { MAX_JOIN_RANK, MAX_PARTICIPANTS } from '../limits';
import type { TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { PARTICIPANT_COLOR_COUNT, type Participant, type ParticipantId } from './participants';

export interface Roster {
  readonly participants: readonly Participant[];
  readonly nextRank: number;
}

export type RosterRefusal = 'ROSTER_FULL' | 'ALREADY_IN' | 'UNKNOWN_PARTICIPANT' | 'HOST_RIGHT';

/** Starts the list of participants of a shared plan with its host, who can always edit. */
export function startRoster(hostId: ParticipantId, name: string): Roster {
  return {
    participants: [
      { id: hostId, name, color: 0, canEdit: true, isHost: true, rank: 0, selectedTaskId: null },
    ],
    nextRank: 1,
  };
}

/** Adds a participant who just joined, in read only, with the first color nobody uses, refusing a full list, an identifier already in it, or a list whose ranks are spent. */
export function joinRoster(
  roster: Roster,
  id: ParticipantId,
  name: string,
): Result<Roster, RosterRefusal> {
  if (roster.participants.length >= MAX_PARTICIPANTS || roster.nextRank > MAX_JOIN_RANK) {
    return failure('ROSTER_FULL');
  }
  if (roster.participants.some((participant) => participant.id === id)) {
    return failure('ALREADY_IN');
  }
  const participant: Participant = {
    id,
    name,
    color: firstFreeColor(roster.participants),
    canEdit: false,
    isHost: false,
    rank: roster.nextRank,
    selectedTaskId: null,
  };
  return success({
    participants: [...roster.participants, participant],
    nextRank: roster.nextRank + 1,
  });
}

/** Returns the first color of the palette no participant uses, or the color of the rank when every color is taken. */
function firstFreeColor(participants: readonly Participant[]): number {
  const used = new Set(participants.map((participant) => participant.color));
  const free = Array.from({ length: PARTICIPANT_COLOR_COUNT }, (_unused, color) => color).find(
    (color) => !used.has(color),
  );
  return free ?? participants.length % PARTICIPANT_COLOR_COUNT;
}

/** Lets a participant edit or puts it in read only, refusing an unknown participant and any change of the right of the host, who always edits. */
export function setRight(
  roster: Roster,
  id: ParticipantId,
  canEdit: boolean,
): Result<Roster, RosterRefusal> {
  const target = roster.participants.find((participant) => participant.id === id);
  if (target === undefined) {
    return failure('UNKNOWN_PARTICIPANT');
  }
  if (target.isHost) {
    return failure('HOST_RIGHT');
  }
  return success(replaceParticipant(roster, { ...target, canEdit }));
}

/** Changes the name and the selected task of a participant from its presence, leaving the list as it is for an unknown participant. */
export function updatePresence(
  roster: Roster,
  id: ParticipantId,
  presence: { readonly name: string; readonly selectedTaskId: TaskId | null },
): Roster {
  const target = roster.participants.find((participant) => participant.id === id);
  return target === undefined ? roster : replaceParticipant(roster, { ...target, ...presence });
}

/** Removes a participant who left, the host leaving being handled by electing the next one. */
export function leaveRoster(roster: Roster, id: ParticipantId): Roster {
  return {
    ...roster,
    participants: roster.participants.filter((participant) => participant.id !== id),
  };
}

/** Tells whether the host accepts a change of the plan from a participant: only from one in the list who can edit. */
export function mayEdit(roster: Roster, id: ParticipantId): boolean {
  return roster.participants.some((participant) => participant.id === id && participant.canEdit);
}

/** Chooses the participant who becomes the host when the host is gone, the one connected the longest, and makes it the host with its right to edit, or returns null when nobody is left. */
export function electHost(roster: Roster): Roster | null {
  const remaining = roster.participants.filter((participant) => !participant.isHost);
  const next = remaining.reduce<Participant | null>(
    (best, participant) => (best === null || isOlder(participant, best) ? participant : best),
    null,
  );
  if (next === null) {
    return null;
  }
  return replaceParticipant(
    { ...roster, participants: remaining },
    { ...next, isHost: true, canEdit: true },
  );
}

/** Tells whether a participant joined before another, the identifier deciding between equal ranks so that every copy chooses the same one. */
function isOlder(participant: Participant, other: Participant): boolean {
  return (
    participant.rank < other.rank ||
    (participant.rank === other.rank && compareStrings(participant.id, other.id) < 0)
  );
}

/** Replaces a participant by its new version, keeping the order of the list. */
function replaceParticipant(roster: Roster, changed: Participant): Roster {
  return {
    ...roster,
    participants: roster.participants.map((participant) =>
      participant.id === changed.id ? changed : participant,
    ),
  };
}
