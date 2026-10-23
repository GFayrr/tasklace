import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_COLLABORATION_MESSAGE_BYTES,
  MAX_PARTICIPANT_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_ROSTER_MESSAGE_BYTES,
} from '../limits';
import { failure, success } from '../result';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { testId } from '../testing/project-builder';
import { encodeMessage, readMessage, type CollaborationMessage } from './messages';
import { requireParticipantId, type Participant, type ParticipantId } from './participants';

const HOST = requireParticipantId('host1');
const GUEST = requireParticipantId('guest1');
const ENCODER = new TextEncoder();

/** Builds a participant of a list sent by the host. */
function participant(id: ParticipantId, overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    name: id,
    color: 0,
    canEdit: false,
    isHost: false,
    rank: 0,
    selectedTaskId: null,
    endpoint: null,
    tokenDigest: null,
    ...overrides,
  };
}

const ROSTER: readonly Participant[] = [
  participant(HOST, { name: 'Camille', canEdit: true, isHost: true }),
  participant(GUEST, {
    name: 'Léa',
    color: 1,
    rank: 1,
    selectedTaskId: testId('t1'),
    endpoint: { addresses: ['192.168.1.24', 'fe80::1%eth0'], port: 47_313 },
    tokenDigest: null,
  }),
];

/** Builds the bytes of a message from its kind code and the JSON of its content. */
function jsonMessage(kind: number, content: unknown): Uint8Array {
  const text = ENCODER.encode(JSON.stringify(content));
  return Uint8Array.from([1, kind, ...text]);
}

describe('messages of a shared plan', () => {
  it.each<CollaborationMessage>([
    { kind: 'stateVector', vector: Uint8Array.of(0) },
    { kind: 'update', update: Uint8Array.of(1, 2, 3) },
    { kind: 'presence', name: 'Léa', selectedTaskId: testId('t1') },
    { kind: 'presence', name: 'Noah', selectedTaskId: null },
    { kind: 'participants', you: GUEST, participants: ROSTER },
    { kind: 'refused' },
  ])('reads back the message %j it wrote', (message) => {
    expect(readMessage(encodeMessage(message))).toEqual(success(message));
  });

  it('writes the version of the format and the kind before the content', () => {
    expect([...encodeMessage({ kind: 'update', update: Uint8Array.of(9) })]).toEqual([1, 2, 9]);
  });

  it('gives a valid participant identifier as one, and throws for any other value', () => {
    expect(requireParticipantId('p1')).toBe('p1');
    expect(() => requireParticipantId('a b')).toThrow(
      new TypeError('Not a participant identifier: a b'),
    );
  });

  it('copies the content it reads, so that the bytes received can be reused', () => {
    const bytes = encodeMessage({ kind: 'update', update: Uint8Array.of(7) });
    const read = readMessage(bytes);
    bytes[2] = 8;
    expect(read).toEqual(success({ kind: 'update', update: Uint8Array.of(7) }));
  });

  it.each([
    ['nothing', Uint8Array.of(), 'UNSUPPORTED_VERSION'],
    ['a version alone', Uint8Array.of(1), 'UNSUPPORTED_VERSION'],
    ['another version', Uint8Array.of(2, 2, 1), 'UNSUPPORTED_VERSION'],
    ['an unknown kind', Uint8Array.of(1, 9, 1), 'UNKNOWN_KIND'],
    ['an empty update', Uint8Array.of(1, 2), 'INVALID_CONTENT'],
    ['a refusal with content', Uint8Array.of(1, 5, 0), 'INVALID_CONTENT'],
    ['text that is not UTF-8', Uint8Array.of(1, 3, 0xff, 0xfe), 'INVALID_CONTENT'],
    ['text that is not JSON', Uint8Array.of(1, 3, 0x7b), 'INVALID_CONTENT'],
  ] as const)('refuses %s', (_label, bytes, refusal) => {
    expect(readMessage(bytes)).toEqual(failure(refusal));
  });

  it('refuses a message larger than allowed, and a list of participants larger than its own limit', () => {
    expect(readMessage(new Uint8Array(MAX_COLLABORATION_MESSAGE_BYTES + 1))).toEqual(
      failure('TOO_LARGE'),
    );
    const large = new Uint8Array(2 + MAX_ROSTER_MESSAGE_BYTES + 1);
    large.set([1, 4]);
    expect(readMessage(large)).toEqual(failure('TOO_LARGE'));
  });

  it.each([
    ['an unknown field', { name: 'Léa', selectedTaskId: null, color: 1 }],
    ['a missing field', { name: 'Léa' }],
    ['an empty name', { name: ' ', selectedTaskId: null }],
    [
      'a name too long',
      { name: 'x'.repeat(MAX_PARTICIPANT_NAME_LENGTH + 1), selectedTaskId: null },
    ],
    ['a name with a control character', { name: 'L\u0007a', selectedTaskId: null }],
    ['a task that is no identifier', { name: 'Léa', selectedTaskId: '../a' }],
    ['a list', [1]],
  ])('refuses a presence with %s', (_label, content) => {
    expect(readMessage(jsonMessage(3, content))).toEqual(failure('INVALID_CONTENT'));
  });

  it.each([
    ['no host', ROSTER.map((item) => ({ ...item, isHost: false }))],
    ['two hosts', ROSTER.map((item) => ({ ...item, isHost: true }))],
    ['an identifier twice', ROSTER.map((item) => ({ ...item, id: HOST }))],
    ['a rank twice', ROSTER.map((item) => ({ ...item, rank: 0 }))],
    ['a color beyond the palette', [ROSTER[0], { ...ROSTER[1], color: 8 }]],
    ['a negative rank', [ROSTER[0], { ...ROSTER[1], rank: -1 }]],
    ['an unknown field', [ROSTER[0], { ...ROSTER[1], address: '10.0.0.1' }]],
    ['an identifier that is no identifier', [ROSTER[0], { ...ROSTER[1], id: 'a b' }]],
    ['a right that is no boolean', [ROSTER[0], { ...ROSTER[1], canEdit: 1 }]],
    ['a participant that is no object', [ROSTER[0], 5]],
    [
      'too many participants',
      Array.from({ length: MAX_PARTICIPANTS + 1 }, (_unused, index) =>
        participant(requireParticipantId(`p${String(index)}`), {
          rank: index,
          isHost: index === 0,
        }),
      ),
    ],
  ])('refuses a list of participants with %s', (_label, participants) => {
    expect(readMessage(jsonMessage(4, { you: GUEST, participants }))).toEqual(
      failure('INVALID_CONTENT'),
    );
  });

  it('refuses a list of participants that does not hold its receiver, or names it badly', () => {
    expect(readMessage(jsonMessage(4, { you: 'stranger', participants: ROSTER }))).toEqual(
      failure('INVALID_CONTENT'),
    );
    expect(readMessage(jsonMessage(4, { you: 42, participants: ROSTER }))).toEqual(
      failure('INVALID_CONTENT'),
    );
    expect(readMessage(jsonMessage(4, [GUEST, ROSTER]))).toEqual(failure('INVALID_CONTENT'));
  });

  it(
    'never throws on any bytes, refusing them or reading a message it writes back to the same bytes',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.uint8Array({ maxLength: 64 }),
            fc
              .tuple(fc.integer({ min: 1, max: 4 }), fc.uint8Array({ maxLength: 64 }))
              .map(([kind, rest]) => Uint8Array.from([1, kind, ...rest])),
          ),
          (bytes) => {
            const read = readMessage(bytes);
            if (read.ok && (read.value.kind === 'stateVector' || read.value.kind === 'update')) {
              expect(encodeMessage(read.value)).toEqual(bytes);
            }
          },
        ),
      );
    },
  );
});
