import { testPlanKey } from '../testing/secrets';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { permutationOf } from '../testing/arbitraries';
import { requireParticipantId, type Participant } from './participants';
import {
  hostingDelay,
  sharingIdOf,
  shouldYield,
  successionQueue,
  SUCCESSION_TURN_MILLISECONDS,
} from './succession';

/** Builds a participant with a rank, allowed to edit unless told otherwise. */
function person(id: string, rank: number, isHost = false, canEdit = true): Participant {
  return {
    id: requireParticipantId(id),
    name: id,
    color: 0,
    canEdit,
    isHost,
    rank,
    selectedTaskId: null,
    endpoint: null,
    tokenDigest: null,
  };
}

const HOST = person('camille', 0, true);

describe('who takes over a plan whose host left', () => {
  it('lines up everyone allowed to edit but the host, oldest first, the identifier deciding between equal ranks', () => {
    const queue = successionQueue([
      person('noah', 3),
      HOST,
      person('lea', 1),
      person('ines', 3),
      person('reader', 0, false, false),
    ]);
    expect(queue.map((participant) => participant.id)).toEqual(['lea', 'ines', 'noah']);
  });

  it('gives every copy of the list the same queue, whatever its order', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.nat({ max: 5 })), {
            selector: ([id]) => id,
            maxLength: 10,
          })
          .chain((entries) => {
            const people = entries.map(([id, rank]) => person(id, rank));
            return fc.tuple(fc.constant(people), permutationOf(people));
          }),
        ([people, shuffled]) => {
          expect(successionQueue(shuffled)).toEqual(successionQueue(people));
        },
      ),
    );
  });

  it('makes each one wait one turn per person before it, and someone outside the queue not at all', () => {
    const queue = successionQueue([HOST, person('lea', 1), person('noah', 2)]);
    expect([
      hostingDelay(queue, requireParticipantId('lea')),
      hostingDelay(queue, requireParticipantId('noah')),
      hostingDelay(queue, requireParticipantId('camille')),
    ]).toEqual([0, SUCCESSION_TURN_MILLISECONDS, null]);
  });

  it('lets the newer of two hosts give way, the identifier deciding between equal ranks', () => {
    expect([
      shouldYield(person('noah', 2), person('lea', 1)),
      shouldYield(person('lea', 1), person('noah', 2)),
      shouldYield(person('noah', 1), person('lea', 1)),
    ]).toEqual([true, false, true]);
  });

  it('announces the same identifier for the same key, another for another key, without the key in it', () => {
    const key = testPlanKey(new Uint8Array(32).fill(1));
    const id = sharingIdOf(key);
    expect([
      id.length,
      id === sharingIdOf(testPlanKey(Uint8Array.from(key))),
      id === sharingIdOf(testPlanKey(new Uint8Array(32))),
    ]).toEqual([32, true, false]);
  });
});
