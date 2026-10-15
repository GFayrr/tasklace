import { readTasklaceDocument, type Compressor, type FileError } from '../file/tasklace-file';
import { failure, type Result } from '../result';
import {
  openSharedSessionFromState,
  type SharedSession,
  type StateOpeningFailure,
} from '../shared/shared-session';

/** Opens a session on a .tasklace file the way the application does: the file read and checked, then a session opened on the state it held. */
export function openTasklaceFile(
  file: Uint8Array,
  compressor: Compressor,
): Result<SharedSession, FileError | StateOpeningFailure> {
  const read = readTasklaceDocument(file, compressor);
  return read.ok ? openSharedSessionFromState(read.value.state) : failure(read.error);
}
