import * as Y from 'yjs';
import { readSharedState, type FileError, type SharedStateReading } from '../../file/tasklace-file';
import { MAX_UNCOMPRESSED_BYTES } from '../../limits';
import { failure, type Result } from '../../result';
import { readMessage } from '../messages';

/** Reads the log a relay passed on up to where a member caught up: the changes of its messages merged in order into one state, read as untrusted like a file, refusing a message that is not a change of the plan and a log larger than a file. */
export function readRelayLog(
  messages: readonly Uint8Array[],
): Result<SharedStateReading, FileError> {
  const updates: Uint8Array[] = [];
  let bytes = 0;
  for (const message of messages) {
    const read = readMessage(message);
    if (!read.ok || read.value.kind !== 'update') {
      return failure({ code: 'INVALID_CONTENT' });
    }
    bytes += read.value.update.length;
    if (bytes > MAX_UNCOMPRESSED_BYTES) {
      return failure({ code: 'TOO_LARGE' });
    }
    updates.push(read.value.update);
  }
  return readSharedState(mergedUpdates(updates));
}

/** Merges changes of a plan into one, giving no bytes for changes Yjs cannot read, which the reading of the state then refuses. */
function mergedUpdates(updates: readonly Uint8Array[]): Uint8Array {
  try {
    return Y.mergeUpdates([...updates]);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return new Uint8Array();
  }
}
