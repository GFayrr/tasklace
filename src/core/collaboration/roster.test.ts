import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_DEPARTED_PARTICIPANTS, MAX_JOIN_RANK, MAX_PARTICIPANTS } from '../limits';
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
  takeOverRoster,
  startRoster,
  updatePresence,
  type Roster,
} from './roster';

const HOST = requireParticipantId('host');
const LEA = requireParticipantId('lea');
const NOAH = requireParticipantId('noah');

const NOAH_ENDPOINT = { addresses: ['192.168.1.30'], port: 47_313 };

/** Builds the list of a host with Léa then Noah, who joined in this order, Noah telling where it could host. */
function threePeople(): Roster {
  return unwrap(
    joinRoster(
      unwrap(joinRoster(startRoster(HOST, 'Camille', null), LEA, 'Léa', null, null)),
      NOAH,
      'Noah',
      NOAH_ENDPOINT,
      null,
    ),
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
          endpoint: null,
          tokenDigest: null,
        },
        {
          id: LEA,
          name: 'Léa',
          color: 1,
          canEdit: false,
          isHost: false,
          rank: 1,
          selectedTaskId: null,
          endpoint: null,
          tokenDigest: null,
        },
        {
          id: NOAH,
          name: 'Noah',
          color: 2,
          canEdit: false,
          isHost: false,
          rank: 2,
          selectedTaskId: null,
          endpoint: NOAH_ENDPOINT,
          tokenDigest: null,
        },
      ],
      departed: [],
      nextRank: 3,
    });
  });

  it('gives a newcomer the first color left free by someone who left', () => {
    const left = leaveRoster(threePeople(), LEA);
    const back = unwrap(joinRoster(left, requireParticipantId('ines'), 'Inès', null, null));
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

  it('brings back a participant who left with its rank, right and color, or the first free color once taken', () => {
    const lea = unwrap(setRight(threePeople(), LEA, true));
    const left = leaveRoster(lea, LEA);
    expect(left.departed.map((participant) => participant.id)).toEqual([LEA]);
    const back = unwrap(joinRoster(left, LEA, 'Léa M.', null, null));
    /** Lists the name, color, rank and right of each participant. */
    const view = (roster: Roster) =>
      roster.participants.map((participant) => [
        participant.name,
        participant.color,
        participant.rank,
        participant.canEdit,
      ]);
    expect([view(back), back.departed, back.nextRank]).toEqual([
      [
        ['Camille', 0, 0, true],
        ['Noah', 2, 2, false],
        ['Léa M.', 1, 1, true],
      ],
      [],
      3,
    ]);
    const taken = unwrap(joinRoster(left, requireParticipantId('ines'), 'Inès', null, null));
    const backAfter = unwrap(joinRoster(taken, LEA, 'Léa', null, null));
    expect(view(backAfter).at(-1)).toEqual(['Léa', 3, 1, true]);
  });

  it('keeps only the latest departures, and leaves the list as it is for someone not in it', () => {
    let roster = startRoster(HOST, 'Camille', null);
    for (let index = 0; index <= MAX_DEPARTED_PARTICIPANTS; index += 1) {
      const id = requireParticipantId(`p${String(index)}`);
      roster = leaveRoster(unwrap(joinRoster(roster, id, 'Someone', null, null)), id);
    }
    expect([roster.departed.length, roster.departed[0]?.id]).toEqual([
      MAX_DEPARTED_PARTICIPANTS,
      'p1',
    ]);
    expect(leaveRoster(roster, LEA)).toBe(roster);
  });

  it('takes over the list of a host that left: the new host edits, everyone else waits among the departures with its rank and right', () => {
    const before = unwrap(setRight(threePeople(), NOAH, true));
    const taken = takeOverRoster(before, LEA);
    expect([
      taken?.participants.map((participant) => [
        participant.id,
        participant.isHost,
        participant.canEdit,
      ]),
      taken?.departed.map((participant) => [
        participant.id,
        participant.isHost,
        participant.canEdit,
        participant.rank,
      ]),
      taken?.nextRank,
    ]).toEqual([
      [[LEA, true, true]],
      [
        [HOST, false, true, 0],
        [NOAH, false, true, 2],
      ],
      3,
    ]);
    const back = unwrap(joinRoster(taken ?? before, HOST, 'Camille', null, null));
    expect(
      back.participants.map((participant) => [
        participant.name,
        participant.rank,
        participant.canEdit,
      ]),
    ).toEqual([
      ['Léa', 1, true],
      ['Camille', 0, true],
    ]);
    expect(takeOverRoster(before, requireParticipantId('nobody'))).toBeNull();
  });

  it('shares the colors once every color is taken', () => {
    let roster = startRoster(HOST, 'Camille', null);
    for (let index = 1; index <= PARTICIPANT_COLOR_COUNT; index += 1) {
      roster = unwrap(
        joinRoster(roster, requireParticipantId(`p${String(index)}`), 'Someone', null, null),
      );
    }
    expect(roster.participants.map((participant) => participant.color)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 0,
    ]);
  });

  it('refuses a participant already in the list, a full list and a list whose ranks are spent', () => {
    expect(joinRoster(threePeople(), LEA, 'Léa again', null, null)).toEqual(failure('ALREADY_IN'));
    let full = startRoster(HOST, 'Camille', null);
    for (let index = 1; index < MAX_PARTICIPANTS; index += 1) {
      full = unwrap(
        joinRoster(full, requireParticipantId(`p${String(index)}`), 'Someone', null, null),
      );
    }
    expect(joinRoster(full, requireParticipantId('late'), 'Late', null, null)).toEqual(
      failure('ROSTER_FULL'),
    );
    const spent = { ...startRoster(HOST, 'Camille', null), nextRank: MAX_JOIN_RANK + 1 };
    expect(joinRoster(spent, LEA, 'Léa', null, null)).toEqual(failure('ROSTER_FULL'));
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
    expect(roster.participants[1]).toEqual({
      ...threePeople().participants[1],
      name: 'Léa B.',
      selectedTaskId: testId('t1'),
    });
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
    expect(electHost(startRoster(HOST, 'Camille', null))).toBeNull();
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
              endpoint: null,
              tokenDigest: null,
            }));
            const host = {
              id: requireParticipantId('zzzzzzz'),
              name: 'Camille',
              color: 0,
              canEdit: true,
              isHost: true,
              rank: 0,
              selectedTaskId: null,
              endpoint: null,
              tokenDigest: null,
            };
            const roster: Roster = {
              participants: [host, ...participants],
              departed: [],
              nextRank: 4,
            };
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
