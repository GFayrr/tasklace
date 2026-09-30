import { describe, expect, it } from 'vitest';
import type { FileFailureCode } from '../../preload/bridge-contract';
import { fileErrorMessage } from './messages';

const CODES: readonly FileFailureCode[] = [
  'TOO_LARGE',
  'TRUNCATED',
  'NOT_A_TASKLACE_FILE',
  'UNSUPPORTED_VERSION',
  'NEWER_FORMAT',
  'CORRUPTED',
  'DECOMPRESSION_BOMB',
  'DECOMPRESSION_FAILED',
  'INVALID_CONTENT',
  'INVALID_PROJECT',
  'READ_FAILED',
  'WRITE_FAILED',
  'TOO_COMPLEX',
  'INVALID_ENCODING',
  'INVALID_IMPORT',
  'NO_PROJECT',
  'TASK_FAILED',
];

describe('fileErrorMessage', () => {
  it.each(CODES)('has a sentence for %s', (code) => {
    expect(fileErrorMessage(code)).toMatch(/^[A-Z].+\.$/);
  });

  it('shows nothing for a cancelled action', () => {
    expect(fileErrorMessage('CANCELLED')).toBeNull();
  });
});
