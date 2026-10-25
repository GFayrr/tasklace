import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '../../result';
import { plainCompression, seededRandom, testAead } from '../../testing/test-crypto';
import { AEAD_TAG_BYTES } from '../secure/channel';
import { createRelayAssembler, sealRelayMessage, type RelayCrypto } from './relay-envelope';
import { drawRelayAccess, relayKeysOf, viewAccessOf } from './relay-keys';

const limits = vi.hoisted(() => ({
  messageBytes: 16,
  buffered: 40,
  chunk: 16,
  chunks: 3,
  open: 64,
}));

vi.mock('../../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits')>()),
  get MAX_COLLABORATION_MESSAGE_BYTES() {
    return limits.messageBytes;
  },
  get MAX_RELAY_BUFFERED_BYTES() {
    return limits.buffered;
  },
  get MAX_OPEN_RELAY_MESSAGES() {
    return limits.open;
  },
}));

vi.mock('./relay-wire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relay-wire')>()),
  get RELAY_CHUNK_BYTES() {
    return limits.chunk;
  },
  get MAX_RELAY_CHUNKS() {
    return limits.chunks;
  },
}));

const ACCESS = drawRelayAccess(seededRandom(21));
const EDIT = relayKeysOf(ACCESS);
const VIEW = relayKeysOf(viewAccessOf(ACCESS));
const CRYPTO: RelayCrypto = {
  aead: testAead,
  compression: plainCompression,
  randomBytes: seededRandom(2),
};

/** Seals bytes as a change of the plan with an identifier made of one byte. */
function seal(length: number, id = 1) {
  return sealRelayMessage(
    EDIT,
    {
      kind: 'update',
      messageId: new Uint8Array(16).fill(id),
      covers: 0,
      bytes: new Uint8Array(length),
    },
    CRYPTO,
  );
}

describe('the limits of sealing for the relay', () => {
  it('seals a message up to the limit, refusing a larger one', () => {
    const atLimit = seal(limits.messageBytes);
    expect([atLimit.ok ? atLimit.value.length : atLimit, seal(limits.messageBytes + 1)]).toEqual([
      2,
      failure('TOO_LARGE'),
    ]);
  });

  it('seals a message up to the number of chunks a message may have, refusing one more chunk', () => {
    limits.messageBytes = 64;
    try {
      const largest = seal(limits.chunk * limits.chunks - AEAD_TAG_BYTES);
      expect([
        largest.ok ? largest.value.length : largest,
        seal(limits.chunk * limits.chunks - AEAD_TAG_BYTES + 1),
      ]).toEqual([limits.chunks, failure('TOO_LARGE')]);
    } finally {
      limits.messageBytes = 16;
    }
  });

  it('refuses a chunk that would make the waiting chunks larger than allowed, forgetting its message', () => {
    const assembler = createRelayAssembler(VIEW, { ...CRYPTO, randomBytes: seededRandom(3) });
    const heads = [1, 2, 3].map((id) => {
      const sealed = seal(limits.messageBytes, id);
      const [head] = sealed.ok ? sealed.value : [];
      if (head === undefined) {
        throw new Error('A record was expected.');
      }
      return head;
    });
    expect(heads.map((head, index) => assembler.take(index + 1, head))).toEqual([
      success(null),
      success(null),
      failure('TOO_LARGE'),
    ]);
  });

  it('waits for at most a number of messages at once, refusing the next one', () => {
    limits.buffered = 1_000;
    limits.open = 2;
    try {
      const assembler = createRelayAssembler(VIEW, CRYPTO);
      const heads = [1, 2, 3].map((id) => {
        const sealed = seal(limits.messageBytes, id);
        const [head] = sealed.ok ? sealed.value : [];
        if (head === undefined) {
          throw new Error('A record was expected.');
        }
        return head;
      });
      expect(heads.map((head, index) => assembler.take(index + 1, head))).toEqual([
        success(null),
        success(null),
        failure('TOO_MANY'),
      ]);
    } finally {
      limits.buffered = 40;
      limits.open = 64;
    }
  });
});
