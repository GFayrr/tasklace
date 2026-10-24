import { testJoinCode, testPlanKey, testToken } from '../../testing/secrets';
import { describe, expect, it } from 'vitest';
import { MAX_INTRODUCTION_BYTES } from '../../limits';
import { failure } from '../../result';
import { requireParticipantId } from '../participants';
import {
  answerHostLink,
  drawPlanKey,
  drawRejoinToken,
  encodeIntroduction,
  HELLO_BYTES,
  LINK_VERSION,
  isRejoinToken,
  PROOF_BYTES,
  readIntroduction,
  readPlanKey,
  requireRejoinToken,
  PLAN_KEY_BYTES,
  REPLY_BYTES,
  startHostLink,
  type GuestLink,
  type JoinSecret,
} from './link';

const PLAN_KEY = testPlanKey(
  Uint8Array.from({ length: PLAN_KEY_BYTES }, (_unused, index) => index),
);
const SECRETS = { code: testJoinCode('K7Q4MZ'), planKey: PLAN_KEY };
const TOKEN = testToken('ab'.repeat(32));
const ENDPOINT = { addresses: ['192.168.1.24'], port: 47_313 };

/** Gives the secret of a guest who types a code. */
function code(typed: string): JoinSecret {
  return { kind: 'code', code: testJoinCode(typed) };
}

/** Returns a source of random bytes that repeats a seed. */
function seeded(seed: number): (count: number) => Uint8Array {
  let next = seed;
  return (count) =>
    Uint8Array.from({ length: count }, () => {
      next = (next * 1_103_515_245 + 12_345) % 2_147_483_648;
      return next % 256;
    });
}

/** Answers a hello, failing the test when the guest refuses it. */
function guestOf(hello: Uint8Array, secret: JoinSecret): GuestLink {
  const guest = answerHostLink(hello, secret, seeded(2));
  if (!guest.ok) {
    throw new Error(guest.error);
  }
  return guest.value;
}

/** Writes an introduction with some fields changed, as a forged guest would. */
function introductionBytes(changes: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ participantId: 'a', name: 'A', token: TOKEN, endpoint: ENDPOINT, ...changes }),
  );
}

describe('the opening of a connection', () => {
  it('gives the host and the guest matching keys when the guest types the code of the host', () => {
    const host = startHostLink(SECRETS, seeded(1));
    expect([host.hello.length, host.hello[0]]).toEqual([HELLO_BYTES, LINK_VERSION]);
    const guest = guestOf(host.hello, code('K7Q4MZ'));
    expect(guest.reply).toHaveLength(REPLY_BYTES);
    const answered = host.answer(guest.reply);
    if (!answered.ok) {
      throw new Error(answered.error);
    }
    expect(answered.value.confirm).toHaveLength(PROOF_BYTES);
    const keys = guest.finish(answered.value.confirm);
    expect(keys.ok && [keys.value.send, keys.value.receive]).toEqual([
      answered.value.keys.receive,
      answered.value.keys.send,
    ]);
  });

  it('lets the host refuse a guest with a wrong code before sending any proof of its own', () => {
    const host = startHostLink(SECRETS, seeded(1));
    expect(host.answer(guestOf(host.hello, code('K7Q4MA')).reply)).toEqual(failure('WRONG_CODE'));
  });

  it('gives matching keys to a guest who holds the key of the plan, and refuses another key apart from wrong codes', () => {
    const host = startHostLink(SECRETS, seeded(1));
    const guest = guestOf(host.hello, { kind: 'key', key: PLAN_KEY });
    const answered = host.answer(guest.reply);
    if (!answered.ok) {
      throw new Error(answered.error);
    }
    const keys = guest.finish(answered.value.confirm);
    expect(keys.ok && keys.value.send).toEqual(answered.value.keys.receive);
    const otherKey = testPlanKey(Uint8Array.from(PLAN_KEY).reverse());
    const stranger = guestOf(host.hello, { kind: 'key', key: otherKey });
    expect(host.answer(stranger.reply)).toEqual(failure('WRONG_KEY'));
    expect(stranger.finish(answered.value.confirm)).toEqual(failure('WRONG_KEY'));
  });

  it('refuses a reply whose mode does not match the secret it was made with', () => {
    const host = startHostLink(SECRETS, seeded(1));
    const byCode = Uint8Array.from(guestOf(host.hello, code('K7Q4MZ')).reply);
    const byKey = Uint8Array.from(guestOf(host.hello, { kind: 'key', key: PLAN_KEY }).reply);
    byCode[0] = byKey[0] ?? 0;
    byKey[0] = guestOf(host.hello, code('K7Q4MZ')).reply[0] ?? 0;
    expect([host.answer(byCode), host.answer(byKey)]).toEqual([
      failure('WRONG_KEY'),
      failure('WRONG_CODE'),
    ]);
  });

  it('lets the guest refuse a confirmation that is not the proof of the host', () => {
    const host = startHostLink(SECRETS, seeded(1));
    const guest = guestOf(host.hello, code('K7Q4MZ'));
    expect(guest.finish(new Uint8Array(PROOF_BYTES))).toEqual(failure('WRONG_CODE'));
    expect(guest.finish(new Uint8Array(PROOF_BYTES - 1))).toEqual(failure('MALFORMED'));
  });

  it('refuses a hello or a reply of the wrong length, another version and a share that is no point', () => {
    const host = startHostLink(SECRETS, seeded(1));
    expect(answerHostLink(host.hello.subarray(1), code('K7Q4MZ'), seeded(2))).toEqual(
      failure('MALFORMED'),
    );
    const newer = Uint8Array.from(host.hello);
    newer[0] = LINK_VERSION + 1;
    expect(answerHostLink(newer, code('K7Q4MZ'), seeded(2))).toEqual(
      failure('UNSUPPORTED_VERSION'),
    );
    const pointless = Uint8Array.from(host.hello);
    pointless.fill(255, 1 + 32, HELLO_BYTES);
    expect(answerHostLink(pointless, code('K7Q4MZ'), seeded(2))).toEqual(failure('INVALID_SHARE'));
    expect(answerHostLink(pointless, { kind: 'key', key: PLAN_KEY }, seeded(2))).toEqual(
      failure('INVALID_SHARE'),
    );
    expect(host.answer(new Uint8Array(REPLY_BYTES + 1))).toEqual(failure('MALFORMED'));
    expect(host.answer(new Uint8Array(REPLY_BYTES))).toEqual(failure('INVALID_SHARE'));
    expect(host.answer(new Uint8Array(REPLY_BYTES).fill(2, 0, 1))).toEqual(failure('MALFORMED'));
  });

  it('reads back the introduction of a guest', () => {
    const introduction = {
      participantId: requireParticipantId('lea-1'),
      name: 'Léa',
      token: TOKEN,
      endpoint: ENDPOINT,
    };
    expect(readIntroduction(encodeIntroduction(introduction))).toEqual(introduction);
  });

  it.each([
    ['no JSON', Uint8Array.of(0xff)],
    ['not a record', new TextEncoder().encode('[]')],
    ['an unknown key', introductionBytes({ extra: 1 })],
    ['an invalid identifier', introductionBytes({ participantId: 'a b' })],
    ['an empty name', introductionBytes({ name: ' ' })],
    ['no token', introductionBytes({ token: undefined })],
    ['a short token', introductionBytes({ token: 'ab' })],
    ['a token in capitals', introductionBytes({ token: 'AB'.repeat(32) })],
    ['a token that is no text', introductionBytes({ token: 7 })],
    ['no endpoint', introductionBytes({ endpoint: undefined })],
    ['an endpoint without its port', introductionBytes({ endpoint: { addresses: [] } })],
    ['a port out of range', introductionBytes({ endpoint: { addresses: [], port: 0 } })],
    [
      'too many addresses',
      introductionBytes({ endpoint: { addresses: ['a', 'b', 'c', 'd', 'e'], port: 1 } }),
    ],
    ['an address with a space', introductionBytes({ endpoint: { addresses: ['a b'], port: 1 } })],
    ['an address that is no text', introductionBytes({ endpoint: { addresses: [7], port: 1 } })],
    ['addresses that are no list', introductionBytes({ endpoint: { addresses: 'a', port: 1 } })],
    ['too many bytes', new Uint8Array(MAX_INTRODUCTION_BYTES + 1).fill(32)],
  ])('refuses an introduction with %s', (_label, bytes) => {
    expect(readIntroduction(bytes)).toBeNull();
  });

  it('draws a token of sixty-four hexadecimal digits for each guest', () => {
    expect(drawRejoinToken(() => new Uint8Array(32).fill(171))).toBe('ab'.repeat(32));
  });
});

describe('the secrets of a shared plan', () => {
  it('draws a key of the length of a key, reads only bytes of that length, and refuses a source of too few bytes', () => {
    expect([
      drawPlanKey(seeded(3)).length,
      readPlanKey(new Uint8Array(PLAN_KEY_BYTES - 1)),
    ]).toEqual([PLAN_KEY_BYTES, null]);
    expect(() => drawPlanKey(() => new Uint8Array(1))).toThrow(
      new RangeError('The random source did not give the length of a key.'),
    );
  });

  it('takes as a token only sixty-four lowercase hexadecimal digits', () => {
    expect([TOKEN, 'AB'.repeat(32), 'ab'.repeat(31), 42].map(isRejoinToken)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(() => requireRejoinToken('abc')).toThrow(new TypeError('Not a token: abc'));
  });
});
