import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealRelayMessage } from '../../../src/core/collaboration/relay/relay-envelope';
import {
  drawRelayAccess,
  relayKeysOf,
  type RelayKeys,
} from '../../../src/core/collaboration/relay/relay-keys';
import {
  coveredSequence,
  type RelayRecordKind,
} from '../../../src/core/collaboration/relay/relay-wire';
import { plainCompression, seededRandom, testAead } from '../../../src/core/testing/test-crypto';

export const ROOM_KEYS: RelayKeys = relayKeysOf(drawRelayAccess(seededRandom(5)));
export const OTHER_KEYS: RelayKeys = relayKeysOf(drawRelayAccess(seededRandom(6)));

/** Seals a message of a number of bytes for the room of some keys into the records a member sends the relay. */
export function sealedRecords(
  kind: RelayRecordKind,
  byte: number,
  length: number,
  covers = 0,
  keys: RelayKeys = ROOM_KEYS,
  seen = covers,
): readonly Uint8Array[] {
  const sealed = sealRelayMessage(
    keys,
    {
      ...coveredSequence(kind, covers),
      messageId: new Uint8Array(16).fill(byte),
      seen,
      bytes: new Uint8Array(length).fill(byte),
    },
    { aead: testAead, compression: plainCompression, randomBytes: seededRandom(byte) },
  );
  if (!sealed.ok) {
    throw new Error(`The message could not be sealed: ${sealed.error}`);
  }
  return sealed.value;
}

/** Seals a message expected to fit in one record. */
export function sealedRecord(
  kind: RelayRecordKind,
  byte: number,
  length = 4,
  covers = 0,
): Uint8Array {
  const [record, ...more] = sealedRecords(kind, byte, length, covers);
  if (record === undefined || more.length > 0) {
    throw new Error('One record was expected.');
  }
  return record;
}

/** Makes an empty folder for a test, and gives what removes it. */
export async function temporaryFolder(): Promise<{
  readonly folder: string;
  readonly remove: () => Promise<void>;
}> {
  const folder = await mkdtemp(path.join(tmpdir(), 'tasklace-relay-'));
  return { folder, remove: () => rm(folder, { recursive: true, force: true }) };
}
