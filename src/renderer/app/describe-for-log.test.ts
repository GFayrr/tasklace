import { describe, expect, it, vi } from 'vitest';
import { describeForLog, errorOfEvent, writeConsoleAsText } from './describe-for-log';

/** Builds an error with a fixed stack, so that its description does not depend on where the test runs. */
function errorWithStack(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.stack = `Error: ${message}\n    at here`;
  return error;
}

describe('describeForLog', () => {
  it('keeps a string, and writes other values as JSON with their errors written out', () => {
    expect(describeForLog('plain')).toBe('plain');
    expect(describeForLog({ code: 'X', issues: [{ path: 'a' }] })).toBe(
      '{"code":"X","issues":[{"path":"a"}]}',
    );
    expect(describeForLog({ error: errorWithStack('inside') })).toBe(
      '{"error":"Error: inside\\n    at here"}',
    );
    expect(describeForLog(undefined)).toBe('undefined');
    expect(describeForLog(null)).toBe('null');
  });

  it('writes an error with its stack, its cause and the errors it gathers', () => {
    const cause = errorWithStack('inner cause');
    const outer = errorWithStack('outer', { cause });
    expect(describeForLog(outer)).toBe(
      'Error: outer\n    at here\nCaused by: Error: inner cause\n    at here',
    );
    const both = new AggregateError([errorWithStack('one'), 'two'], 'both');
    both.stack = 'AggregateError: both';
    expect(describeForLog(both)).toBe(
      'AggregateError: both\nInner error 1: Error: one\n    at here\nInner error 2: two',
    );
    const bare = new Error('no stack');
    delete bare.stack;
    expect(describeForLog(bare)).toBe('Error: no stack');
  });

  it('ends a cause that loops, and writes a value that refers to itself as plain text', () => {
    const looping = errorWithStack('looping');
    looping.cause = looping;
    expect(describeForLog(looping)).toBe('Error: looping\n    at here\nCaused by: Error: looping');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(describeForLog(circular)).toBe('[object Object]');
  });
});

describe('writeConsoleAsText', () => {
  it('passes the errors and warnings of a console on as a single text', () => {
    const error = vi.fn();
    const warn = vi.fn();
    const target = { error, warn };
    writeConsoleAsText(target);
    target.error('Failed:', { code: 'X' }, errorWithStack('why'));
    target.warn('Careful:', 3);
    expect(error.mock.calls).toEqual([['Failed: {"code":"X"} Error: why\n    at here']]);
    expect(warn.mock.calls).toEqual([['Careful: 3']]);
  });
});

describe('errorOfEvent', () => {
  it('gives the error of an event, or its message and place when the browser gives none', () => {
    const error = new Error('thrown');
    expect(errorOfEvent(new ErrorEvent('error', { error }))).toBe(error);
    expect(
      errorOfEvent(
        new ErrorEvent('error', {
          error: null,
          message: 'Script error.',
          filename: 'app://tasklace/x.js',
          lineno: 3,
          colno: 9,
        }),
      ),
    ).toBe('Script error. (app://tasklace/x.js:3:9)');
  });
});
