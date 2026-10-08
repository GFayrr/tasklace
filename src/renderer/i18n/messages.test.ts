import { describe, expect, it } from 'vitest';
import type { FileFailureCode } from '../../preload/bridge-contract';
import {
  countMessage,
  editErrorMessage,
  issueMessage,
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

  it('shows nothing for a canceled action', () => {
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

describe('issueMessage', () => {
  it('explains a problem the project found with its own text, never with the help to write a value', () => {
    expect(issueMessage(messages, 'INVALID_DURATION')).toBe(messages.issues.INVALID_DURATION);
    expect(issueMessage(messages, 'INVALID_DATE')).toBe(messages.issues.INVALID_DATE);
    expect(issueMessage(messages, 'INVALID_HOURS_PER_DAY')).toBe(
      messages.issues.INVALID_HOURS_PER_DAY,
    );
    expect(issueMessage(messages, 'EMPTY_TEXT')).toBe(messages.issues.EMPTY_TEXT);
  });

  it('keeps the text written for a single change for the problems such a change makes', () => {
    for (const code of [
      'DEPENDENCY_CYCLE',
      'DUPLICATE_DEPENDENCY',
      'HIERARCHY_TOO_DEEP',
      'TOO_MANY_ITEMS',
      'TOO_MANY_TAGS',
      'UNKNOWN_BLOCK',
    ] as const) {
      expect(issueMessage(messages, code)).toBe(messages.editErrors[code]);
    }
  });
});

describe('editErrorMessage', () => {
  it('explains a reason with its own text first, even when the problem found has one too', () => {
    expect(editErrorMessage(messages, 'DEPENDENCY_CYCLE')).toBe(
      messages.editErrors.DEPENDENCY_CYCLE,
    );
    expect(messages.editErrors.DEPENDENCY_CYCLE).not.toBe(messages.issues.DEPENDENCY_CYCLE);
    expect(editErrorMessage(messages, 'NOT_POSSIBLE')).toBe(messages.editErrors.NOT_POSSIBLE);
  });

  it('gives the text of the problem found for a reason that has no edit message of its own', () => {
    expect(editErrorMessage(messages, 'EMPTY_TEXT')).toBe(messages.issues.EMPTY_TEXT);
    expect(editErrorMessage(messages, 'TOO_LONG')).toBe(messages.editErrors.TOO_LONG);
  });
});
