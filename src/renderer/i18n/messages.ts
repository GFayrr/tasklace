import type { FileFailureCode } from '../../preload/bridge-contract';
import en from '../locales/en.json';

export type ShownFailureCode = Exclude<FileFailureCode, 'CANCELLED'>;

const FILE_ERROR_MESSAGES: Readonly<Record<ShownFailureCode, string>> = en.fileErrors;

/** Returns the message telling the user why a file action failed, a cancelled action needing none. */
export function fileErrorMessage(code: FileFailureCode): string | null {
  return code === 'CANCELLED' ? null : FILE_ERROR_MESSAGES[code];
}
