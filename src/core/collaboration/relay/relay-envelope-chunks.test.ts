import { describe, expect, it, vi } from 'vitest';
import { RELAY_ABANDON_AFTER_RECORDS } from '../../limits';
import { plainCompression, seededRandom, testAead } from '../../testing/test-crypto';
import { AEAD_TAG_BYTES } from '../secure/channel';
import {
  createRelayAssembler,
  sealRelayMessage,
  type RelayCrypto,
  type RelayMessage,
} from './relay-envelope';
import { drawRelayAccess, relayKeysOf, viewAccessOf } from './relay-keys';
import { readRelayRecord } from './relay-wire';

const CHUNK_BYTES = 16;
const TWO_CHUNKS = CHUNK_BYTES * 2 - AEAD_TAG_BYTES;

vi.mock('./relay-wire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relay-wire')>()),
  RELAY_CHUNK_BYTES: 16,
}));

const ACCESS = drawRelayAccess(seededRandom(31));
const EDIT = relayKeysOf(ACCESS);
const VIEW = relayKeysOf(viewAccessOf(ACCESS));

/** Gives the test cipher and compression with a random source of a seed. */
function cryptoOf(seed = 1): RelayCrypto {
  return { aead: testAead, compression: plainCompression, randomBytes: seededRandom(seed) };
}

/** Builds a change of the plan of some length with an identifier made of one byte. */
function message(length: number, id: number): RelayMessage {
  return {
    kind: 'update',
    messageId: new Uint8Array(16).fill(id),
    covers: 0,
    bytes: Uint8Array.from({ length }, (_unused, index) => index % 251),
  };
}

/** Seals a message with the keys to edit, failing the test when it is refused. */
function sealed(content: RelayMessage, seed = 1): readonly Uint8Array[] {
  const records = sealRelayMessage(EDIT, content, cryptoOf(seed));
  if (!records.ok) {
    throw new Error(`Refused: ${records.error}`);
  }
  return records.value;
}

/** Gives the record at a place, failing the test when there is none. */
function at(records: readonly Uint8Array[], index: number): Uint8Array {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`No record ${String(index)}`);
  }
  return record;
}

/** Tells what taking a record gave: the identifier of an opened message, nothing yet, or the refusal. */
function outcome(result: ReturnType<ReturnType<typeof createRelayAssembler>['take']>) {
  if (!result.ok) {
    return result;
  }
  return result.value === null ? 'waiting' : result.value.messageId[0];
}

describe('the chunks of a message on the relay', () => {
  it('cuts a message into chunks of the chunk size, opened once the last one comes, whatever their order', () => {
    const content = message(CHUNK_BYTES * 2 + 5, 2);
    const records = sealed(content);
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    const early = [
      assembler.take(1, at(records, 3)),
      assembler.take(2, at(records, 0)),
      assembler.take(3, at(records, 0)),
      assembler.take(4, at(records, 2)),
    ].map(outcome);
    const settledWhileOpen = assembler.settled();
    const last = assembler.take(5, at(records, 1));
    expect([
      records.map((record) => readRelayRecord(record)?.chunk.length),
      early,
      settledWhileOpen,
      last.ok && last.value !== null ? last.value.bytes : last,
      assembler.settled(),
    ]).toEqual([
      [CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 5 + AEAD_TAG_BYTES - CHUNK_BYTES],
      ['waiting', 'waiting', 'waiting', 'waiting'],
      0,
      content.bytes,
      5,
    ]);
  });

  it('opens two messages whose chunks come mixed, as from two authors at once', () => {
    const large = sealed(message(TWO_CHUNKS, 1));
    const small = sealed(message(0, 2), 2);
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    expect(
      [
        assembler.take(5, at(large, 0)),
        assembler.take(6, at(small, 0)),
        assembler.take(7, at(large, 1)),
      ].map(outcome),
    ).toEqual(['waiting', 2, 1]);
  });

  it('keeps apart the chunks of one message sealed twice under two salts, as when a member sends it again', () => {
    const once = sealed(message(TWO_CHUNKS, 5), 1);
    const twice = sealed(message(TWO_CHUNKS, 5), 2);
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    expect(
      [
        assembler.take(1, at(once, 0)),
        assembler.take(2, at(twice, 1)),
        assembler.take(3, at(twice, 0)),
      ].map(outcome),
    ).toEqual(['waiting', 'waiting', 5]);
  });

  it('gives up a message whose next chunk does not come for too many records, so that it never holds back what is settled', () => {
    const large = sealed(message(CHUNK_BYTES + 1, 8));
    const small = sealed(message(0, 9), 2);
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    assembler.take(10, at(large, 0));
    const heldBack = assembler.settled();
    const later = 10 + RELAY_ABANDON_AFTER_RECORDS + 1;
    assembler.take(later, at(small, 0));
    expect([
      heldBack,
      assembler.settled(),
      outcome(assembler.take(later + 1, at(large, 1))),
    ]).toEqual([9, later, 'waiting']);
  });

  it('keeps a message that waited exactly as long as allowed', () => {
    const large = sealed(message(TWO_CHUNKS, 8));
    const small = sealed(message(0, 9), 2);
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    assembler.take(10, at(large, 0));
    assembler.take(10 + RELAY_ABANDON_AFTER_RECORDS, at(small, 0));
    expect([
      assembler.settled(),
      outcome(assembler.take(10 + RELAY_ABANDON_AFTER_RECORDS, at(large, 1))),
    ]).toEqual([9, 8]);
  });

  it('opens a message whose last chunk is full', () => {
    const records = sealed(message(TWO_CHUNKS, 3));
    const assembler = createRelayAssembler(VIEW, cryptoOf());
    expect([
      records.length,
      outcome(assembler.take(1, at(records, 0))),
      outcome(assembler.take(2, at(records, 1))),
    ]).toEqual([2, 'waiting', 3]);
  });
});
