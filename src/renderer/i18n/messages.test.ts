import { describe, expect, it } from 'vitest';
import type { FileFailureCode } from '../../preload/bridge-contract';
import {
  countMessage,
  editErrorMessage,
  fileErrorMessage,
  fillMessage,
  loadMessages,
} from './messages';

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
const messages = await loadMessages('en');

describe('fileErrorMessage', () => {
  it.each(CODES)('has a sentence for %s', (code) => {
    expect(fileErrorMessage(messages, code)).toMatch(/^[A-Z].+\.$/);
  });

  it('shows nothing for a cancelled action', () => {
    expect(fileErrorMessage(messages, 'CANCELLED')).toBeNull();
  });
});

describe('fillMessage', () => {
  it('replaces known placeholders only', () => {
    expect(fillMessage('{start} – {end} {other}', { start: 'a', end: 'b' })).toBe('a – b {other}');
  });

  it('never reads inherited properties as values', () => {
    expect(fillMessage('{toString}', {})).toBe('{toString}');
  });
});

describe('countMessage', () => {
  it('chooses the form for the count and writes it in the regional format', () => {
    expect(countMessage(messages.status.tasks, 1, 'en-US')).toBe('1 task');
    expect(countMessage(messages.status.tasks, 0, 'en-US')).toBe('0 tasks');
    expect(countMessage(messages.status.tasks, 12_345, 'en-US')).toBe('12,345 tasks');
    expect(countMessage(messages.status.tasks, 12_345, 'fr-FR')).toBe('12\u202F345 tasks');
  });
});

describe('editErrorMessage', () => {
  it('explains a known reason, and falls back to a general sentence', () => {
    expect(editErrorMessage(messages, 'DEPENDENCY_CYCLE')).toMatch(/loop/);
    expect(editErrorMessage(messages, 'SOMETHING_ELSE')).toBe(messages.editErrors.NOT_POSSIBLE);
    expect(editErrorMessage(messages, 'toString')).toBe(messages.editErrors.NOT_POSSIBLE);
  });

  it('gives the text of the problem found for a reason that has no edit message of its own', () => {
    expect(editErrorMessage(messages, 'EMPTY_TEXT')).toBe(messages.issues.EMPTY_TEXT);
    expect(editErrorMessage(messages, 'TOO_LONG')).toBe(messages.editErrors.TOO_LONG);
  });
});
