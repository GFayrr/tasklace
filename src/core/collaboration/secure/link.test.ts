import { describe, expect, it } from 'vitest';
import { MAX_INTRODUCTION_BYTES } from '../../limits';
import { failure } from '../../result';
import { requireParticipantId } from '../participants';
import {
  answerHostLink,
  encodeIntroduction,
  HELLO_BYTES,
  LINK_VERSION,
  PROOF_BYTES,
  readIntroduction,
  REPLY_BYTES,
  startHostLink,
  type GuestLink,
} from './link';

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
function guestOf(hello: Uint8Array, code: string): GuestLink {
  const guest = answerHostLink(hello, code, seeded(2));
  if (!guest.ok) {
    throw new Error(guest.error);
  }
  return guest.value;
}

describe('the opening of a connection', () => {
  it('gives the host and the guest matching keys when the guest types the code of the host', () => {
    const host = startHostLink('K7Q4MZ', seeded(1));
    expect([host.hello.length, host.hello[0]]).toEqual([HELLO_BYTES, LINK_VERSION]);
    const guest = guestOf(host.hello, 'K7Q4MZ');
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
    const host = startHostLink('K7Q4MZ', seeded(1));
    expect(host.answer(guestOf(host.hello, 'K7Q4MA').reply)).toEqual(failure('WRONG_CODE'));
  });

  it('lets the guest refuse a confirmation that is not the proof of the host', () => {
    const host = startHostLink('K7Q4MZ', seeded(1));
    const guest = guestOf(host.hello, 'K7Q4MZ');
    expect(guest.finish(new Uint8Array(PROOF_BYTES))).toEqual(failure('WRONG_CODE'));
    expect(guest.finish(new Uint8Array(PROOF_BYTES - 1))).toEqual(failure('MALFORMED'));
  });

  it('refuses a hello or a reply of the wrong length, another version and a share that is no point', () => {
    const host = startHostLink('K7Q4MZ', seeded(1));
    expect(answerHostLink(host.hello.subarray(1), 'K7Q4MZ', seeded(2))).toEqual(
      failure('MALFORMED'),
    );
    const newer = Uint8Array.from(host.hello);
    newer[0] = LINK_VERSION + 1;
    expect(answerHostLink(newer, 'K7Q4MZ', seeded(2))).toEqual(failure('UNSUPPORTED_VERSION'));
    const pointless = Uint8Array.from(host.hello);
    pointless.fill(255, HELLO_BYTES - 32);
    expect(answerHostLink(pointless, 'K7Q4MZ', seeded(2))).toEqual(failure('INVALID_SHARE'));
    expect(host.answer(new Uint8Array(REPLY_BYTES + 1))).toEqual(failure('MALFORMED'));
    expect(host.answer(new Uint8Array(REPLY_BYTES))).toEqual(failure('INVALID_SHARE'));
  });

  it('reads back the introduction of a guest', () => {
    const introduction = { participantId: requireParticipantId('lea-1'), name: 'Léa' };
    expect(readIntroduction(encodeIntroduction(introduction))).toEqual(introduction);
  });

  it.each([
    ['no JSON', Uint8Array.of(0xff)],
    ['not a record', new TextEncoder().encode('[]')],
    ['an unknown key', new TextEncoder().encode('{"participantId":"a","name":"A","extra":1}')],
    ['an invalid identifier', new TextEncoder().encode('{"participantId":"a b","name":"A"}')],
    ['an empty name', new TextEncoder().encode('{"participantId":"a","name":" "}')],
    ['too many bytes', new Uint8Array(MAX_INTRODUCTION_BYTES + 1).fill(32)],
  ])('refuses an introduction with %s', (_label, bytes) => {
    expect(readIntroduction(bytes)).toBeNull();
  });
});
