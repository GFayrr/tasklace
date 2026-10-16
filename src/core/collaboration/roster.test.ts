import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_JOIN_RANK, MAX_PARTICIPANTS } from '../limits';
import { failure } from '../result';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { testId } from '../testing/project-builder';
import { PARTICIPANT_COLOR_COUNT, requireParticipantId } from './participants';
import {
  electHost,
  joinRoster,
  leaveRoster,
  mayEdit,
  setRight,
  startRoster,
  updatePresence,
  type Roster,
} from './roster';

const HOST = requireParticipantId('host');
const LEA = requireParticipantId('lea');
const NOAH = requireParticipantId('noah');

/** Builds the list of a host with Léa then Noah, who joined in this order. */
function threePeople(): Roster {
  return unwrap(
    joinRoster(unwrap(joinRoster(startRoster(HOST, 'Camille'), LEA, 'Léa')), NOAH, 'Noah'),
  );
}

describe('the participants of a shared plan', () => {
  it('starts with the host, who edits, and lets newcomers join in read only, each with the next color and rank', () => {
    expect(threePeople()).toEqual({
      participants: [
        {
          id: HOST,
          name: 'Camille',
          color: 0,
          canEdit: true,
          isHost: true,
          rank: 0,
          selectedTaskId: null,
        },
        {
          id: LEA,
          name: 'Léa',
          color: 1,
          canEdit: false,
          isHost: false,
          rank: 1,
          selectedTaskId: null,
        },
        {
          id: NOAH,
          name: 'Noah',
          color: 2,
          canEdit: false,
          isHost: false,
          rank: 2,
          selectedTaskId: null,
        },
      ],
      nextRank: 3,
    });
  });

  it('gives a newcomer the first color left free by someone who left', () => {
    const left = leaveRoster(threePeople(), LEA);
    const back = unwrap(joinRoster(left, requireParticipantId('ines'), 'Inès'));
    expect(
      back.participants.map((participant) => [
        participant.name,
        participant.color,
        participant.rank,
      ]),
    ).toEqual([
      ['Camille', 0, 0],
      ['Noah', 2, 2],
      ['Inès', 1, 3],
    ]);
  });

  it('shares the colors once every color is taken', () => {
    let roster = startRoster(HOST, 'Camille');
    for (let index = 1; index <= PARTICIPANT_COLOR_COUNT; index += 1) {
      roster = unwrap(joinRoster(roster, requireParticipantId(`p${String(index)}`), 'Someone'));
    }
    expect(roster.participants.map((participant) => participant.color)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 0,
    ]);
  });

  it('refuses a participant already in the list, a full list and a list whose ranks are spent', () => {
    expect(joinRoster(threePeople(), LEA, 'Léa again')).toEqual(failure('ALREADY_IN'));
    let full = startRoster(HOST, 'Camille');
    for (let index = 1; index < MAX_PARTICIPANTS; index += 1) {
      full = unwrap(joinRoster(full, requireParticipantId(`p${String(index)}`), 'Someone'));
    }
    expect(joinRoster(full, requireParticipantId('late'), 'Late')).toEqual(failure('ROSTER_FULL'));
    const spent = { ...startRoster(HOST, 'Camille'), nextRank: MAX_JOIN_RANK + 1 };
    expect(joinRoster(spent, LEA, 'Léa')).toEqual(failure('ROSTER_FULL'));
  });

  it('lets the host give and take back the right to edit, never its own, and only the participants with it may edit', () => {
    const roster = unwrap(setRight(threePeople(), LEA, true));
    expect(
      [HOST, LEA, NOAH, requireParticipantId('stranger')].map((id) => mayEdit(roster, id)),
    ).toEqual([true, true, false, false]);
    expect(mayEdit(unwrap(setRight(roster, LEA, false)), LEA)).toBe(false);
    expect(setRight(roster, HOST, false)).toEqual(failure('HOST_RIGHT'));
    expect(setRight(roster, requireParticipantId('stranger'), true)).toEqual(
      failure('UNKNOWN_PARTICIPANT'),
    );
  });

  it('follows the name and the selected task of a participant, ignoring an unknown one', () => {
    const roster = updatePresence(threePeople(), LEA, {
      name: 'Léa B.',
      selectedTaskId: testId('t1'),
    });
    expect(roster.participants[1]).toMatchObject({ name: 'Léa B.', selectedTaskId: 't1' });
    expect(
      updatePresence(roster, requireParticipantId('stranger'), { name: 'X', selectedTaskId: null }),
    ).toBe(roster);
  });

  it('makes the participant connected the longest the host when the host is gone, with the right to edit, and nobody when alone', () => {
    const elected = electHost(threePeople());
    expect(
      elected?.participants.map((participant) => [
        participant.id,
        participant.isHost,
        participant.canEdit,
      ]),
    ).toEqual([
      [LEA, true, true],
      [NOAH, false, false],
    ]);
    expect(electHost(startRoster(HOST, 'Camille'))).toBeNull();
  });

  it('decides between equal ranks by identifier', () => {
    const roster = threePeople();
    const tied = {
      ...roster,
      participants: roster.participants.map((participant) =>
        participant.id === NOAH ? { ...participant, rank: 1 } : participant,
      ),
    };
    expect(electHost(tied)?.participants.find((participant) => participant.isHost)?.id).toBe(LEA);
  });

  it(
    'elects the same host whatever the order in which each copy holds the list',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 12 }),
          fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 12, maxLength: 12 }),
          (names, ranks) => {
            const participants = names.map((name, index) => ({
              id: requireParticipantId(name),
              name,
              color: 0,
              canEdit: false,
              isHost: false,
              rank: ranks[index] ?? 0,
              selectedTaskId: null,
            }));
            const host = {
              id: requireParticipantId('zzzzzzz'),
              name: 'Camille',
              color: 0,
              canEdit: true,
              isHost: true,
              rank: 0,
              selectedTaskId: null,
            };
            const roster: Roster = { participants: [host, ...participants], nextRank: 4 };
            const reversed: Roster = {
              ...roster,
              participants: [...roster.participants].reverse(),
            };
            /** Returns the host a copy of the list elects. */
            const hostOf = (copy: Roster) =>
              electHost(copy)?.participants.find((participant) => participant.isHost)?.id;
            expect(hostOf(reversed)).toBe(hostOf(roster));
          },
        ),
      );
    },
  );
});
