import { describe, expect, it } from 'vitest';
import { MAX_IDENTIFIER_LENGTH, MAX_REPORTED_ISSUES } from '../limits';
import { createIssueList, type IssueList, type ValidationIssue } from './validation-issues';
import {
  childField,
  itemField,
  readArray,
  readBoolean,
  readEnum,
  readIdentifier,
  readInteger,
  readNullable,
  readPatternString,
  readRawString,
  readRecord,
  readText,
  type Field,
} from './value-readers';

const PATH = 'root.value';

/** Runs a reader on a value and returns both its result and the issues it reported. */
function run<T>(
  value: unknown,
  read: (field: Field, issues: IssueList) => T,
): { readonly result: T; readonly issues: readonly ValidationIssue[] } {
  const issues = createIssueList();
  const result = read({ value, path: PATH }, issues);
  return { result, issues: issues.issues };
}

/** Returns the issue codes reported by a reader on a value. */
function codes(value: unknown, read: (field: Field, issues: IssueList) => unknown): string[] {
  return run(value, read).issues.map((issue) => issue.code);
}

describe('createIssueList', () => {
  it('records issues in order', () => {
    const issues = createIssueList();
    issues.add('a', 'MISSING_FIELD');
    issues.add('b', 'WRONG_TYPE');
    expect(issues.issues).toEqual([
      { path: 'a', code: 'MISSING_FIELD' },
      { path: 'b', code: 'WRONG_TYPE' },
    ]);
  });

  it('ends with a single TOO_MANY_ISSUES entry once the reporting limit is reached', () => {
    const issues = createIssueList();
    for (let index = 0; index < MAX_REPORTED_ISSUES * 2; index += 1) {
      issues.add(`item${String(index)}`, 'WRONG_TYPE');
    }
    expect(issues.issues).toHaveLength(MAX_REPORTED_ISSUES);
    expect(issues.issues.at(-2)?.path).toBe(`item${String(MAX_REPORTED_ISSUES - 2)}`);
    expect(issues.issues.at(-1)).toEqual({ path: '', code: 'TOO_MANY_ISSUES' });
  });

  it('keeps every issue below the reporting limit', () => {
    const issues = createIssueList();
    for (let index = 0; index < MAX_REPORTED_ISSUES - 1; index += 1) {
      issues.add(`item${String(index)}`, 'WRONG_TYPE');
    }
    expect(issues.issues.map((issue) => issue.code)).not.toContain('TOO_MANY_ISSUES');
  });
});

describe('childField and itemField', () => {
  it('builds dotted and indexed paths', () => {
    expect(childField({ a: 1 }, 'a', '')).toEqual({ value: 1, path: 'a' });
    expect(childField({ a: 1 }, 'a', 'parent')).toEqual({ value: 1, path: 'parent.a' });
    expect(itemField(['x', 'y'], 1, 'list')).toEqual({ value: 'y', path: 'list[1]' });
    expect(itemField([], 3, 'list')).toEqual({ value: undefined, path: 'list[3]' });
  });

  it('never reads a property through the prototype chain', () => {
    expect(childField({}, 'toString', '').value).toBeUndefined();
    expect(childField({}, '__proto__', '').value).toBeUndefined();
    expect(
      childField(Object.create({ inherited: 1 }) as Record<string, unknown>, 'inherited', '').value,
    ).toBeUndefined();
  });

  it('reads an own property named __proto__ as plain data', () => {
    const record = JSON.parse('{"__proto__": 5}') as Record<string, unknown>;
    expect(childField(record, '__proto__', '').value).toBe(5);
  });
});

describe('readRecord', () => {
  /** Reads a record with the keys a and b. */
  const read = (field: Field, issues: IssueList): unknown => readRecord(field, issues, ['a', 'b']);

  it('accepts a plain object with allowed keys only', () => {
    expect(run({ a: 1 }, read)).toEqual({ result: { a: 1 }, issues: [] });
  });

  it('accepts an object without prototype', () => {
    const record = Object.create(null) as Record<string, unknown>;
    record['a'] = 1;
    expect(run(record, read).issues).toEqual([]);
  });

  it('reports every unknown key with its path', () => {
    expect(run({ a: 1, c: 2, d: 3 }, read)).toEqual({
      result: { a: 1, c: 2, d: 3 },
      issues: [
        { path: `${PATH}.c`, code: 'UNKNOWN_FIELD' },
        { path: `${PATH}.d`, code: 'UNKNOWN_FIELD' },
      ],
    });
  });

  it('reports unknown keys without a leading dot at the root', () => {
    const issues = createIssueList();
    readRecord({ value: { z: 1 }, path: '' }, issues, []);
    expect(issues.issues).toEqual([{ path: 'z', code: 'UNKNOWN_FIELD' }]);
  });

  it('reports an own __proto__ key parsed from JSON as unknown', () => {
    expect(codes(JSON.parse('{"__proto__": {"polluted": true}}'), read)).toEqual(['UNKNOWN_FIELD']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reports a missing value', () => {
    expect(run(undefined, read)).toEqual({
      result: undefined,
      issues: [{ path: PATH, code: 'MISSING_FIELD' }],
    });
  });

  it.each([null, [], 'text', 0, true, new Date(0), new Map(), () => 0])(
    'rejects %p as a wrong type',
    (value) => {
      expect(run(value, read)).toEqual({
        result: undefined,
        issues: [{ path: PATH, code: 'WRONG_TYPE' }],
      });
    },
  );
});

describe('readArray', () => {
  /** Reads a list of at most two items. */
  const read = (field: Field, issues: IssueList): unknown => readArray(field, issues, 2);

  it('accepts an array up to the maximum length', () => {
    expect(run([], read).result).toEqual([]);
    expect(run([1, 2], read).result).toEqual([1, 2]);
  });

  it('rejects a longer array', () => {
    expect(run([1, 2, 3], read)).toEqual({
      result: undefined,
      issues: [{ path: PATH, code: 'TOO_MANY_ITEMS' }],
    });
  });

  it('rejects a missing value and other types', () => {
    expect(codes(undefined, read)).toEqual(['MISSING_FIELD']);
    expect(codes({ length: 1 }, read)).toEqual(['WRONG_TYPE']);
    expect(codes(null, read)).toEqual(['WRONG_TYPE']);
  });
});

describe('readInteger', () => {
  /** Reads a whole number from -5 to 10. */
  const read = (field: Field, issues: IssueList): unknown => readInteger(field, issues, -5, 10);

  it('accepts whole numbers within both bounds', () => {
    expect(run(-5, read).result).toBe(-5);
    expect(run(0, read).result).toBe(0);
    expect(run(-0, read).issues).toEqual([]);
    expect(run(10, read).result).toBe(10);
  });

  it.each([-6, 11, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])(
    'rejects %p as out of range',
    (value) => {
      expect(codes(value, read)).toEqual(['OUT_OF_RANGE']);
    },
  );

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '3', null, 3n])(
    'rejects %p as a wrong type',
    (value) => {
      expect(codes(value, read)).toEqual(['WRONG_TYPE']);
    },
  );

  it('reports a missing value', () => {
    expect(codes(undefined, read)).toEqual(['MISSING_FIELD']);
  });
});

describe('readBoolean', () => {
  it('accepts true and false only', () => {
    expect(run(true, readBoolean).result).toBe(true);
    expect(run(false, readBoolean).result).toBe(false);
    expect(codes(0, readBoolean)).toEqual(['WRONG_TYPE']);
    expect(codes('true', readBoolean)).toEqual(['WRONG_TYPE']);
    expect(codes(undefined, readBoolean)).toEqual(['MISSING_FIELD']);
  });
});

describe('readEnum', () => {
  /** Reads one of the values one and two. */
  const read = (field: Field, issues: IssueList): unknown =>
    readEnum(field, issues, ['one', 'two']);

  it('accepts an allowed value', () => {
    expect(run('two', read)).toEqual({ result: 'two', issues: [] });
  });

  it('is case sensitive and rejects unknown values', () => {
    expect(run('Two', read)).toEqual({
      result: undefined,
      issues: [{ path: PATH, code: 'OUT_OF_RANGE' }],
    });
    expect(codes('', read)).toEqual(['OUT_OF_RANGE']);
    expect(codes('toString', read)).toEqual(['OUT_OF_RANGE']);
  });

  it('rejects a missing value and other types', () => {
    expect(codes(undefined, read)).toEqual(['MISSING_FIELD']);
    expect(codes(1, read)).toEqual(['WRONG_TYPE']);
  });
});

describe('readText', () => {
  const MAX_LENGTH = 5;
  /** Reads a text no longer than the limit. */
  const read = (field: Field, issues: IssueList): unknown => readText(field, issues, MAX_LENGTH);

  it('accepts ordinary and Unicode texts, keeping them unchanged', () => {
    expect(run(' Plan', read).result).toBe(' Plan');
    expect(run('Été 😀', read).result).toBe('Été 😀');
    expect(run('日本語', read).result).toBe('日本語');
  });

  it('counts code points, so a character outside the basic plane counts once', () => {
    expect(run('😀😀😀😀😀', read).issues).toEqual([]);
    expect(codes('😀😀😀😀😀😀', read)).toEqual(['TOO_LONG']);
  });

  it('accepts a text at the maximum length and rejects one beyond it', () => {
    expect(run('abcde', read).issues).toEqual([]);
    expect(run('abcdef', read)).toEqual({
      result: undefined,
      issues: [{ path: PATH, code: 'TOO_LONG' }],
    });
  });

  it('rejects a very long text', () => {
    expect(codes('x'.repeat(1_000_000), read)).toEqual(['TOO_LONG']);
  });

  it.each(['', ' ', '  ', '　'])('rejects the blank text %j', (value) => {
    expect(codes(value, read)).toEqual(['EMPTY_TEXT']);
  });

  it.each(['a\nb', 'a\tb', '\u0000', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb'])(
    'rejects the control characters in %j',
    (value) => {
      expect(codes(value, read)).toEqual(['INVALID_TEXT']);
    },
  );

  it('accepts the characters right after the control ranges', () => {
    expect(run(' ~', read).issues).toEqual([]);
    expect(run(' a', read).issues).toEqual([]);
  });

  it.each(['\ud800', 'a\udc00b', '\udc00\ud800'])('rejects the lone surrogates in %j', (value) => {
    expect(codes(value, read)).toEqual(['INVALID_TEXT']);
  });

  it('rejects a missing value and other types', () => {
    expect(codes(undefined, read)).toEqual(['MISSING_FIELD']);
    expect(codes(['a'], read)).toEqual(['WRONG_TYPE']);
  });
});

describe('readIdentifier', () => {
  it('accepts letters, digits, dashes and underscores', () => {
    expect(run('Task_01-a', readIdentifier).result).toBe('Task_01-a');
    expect(run('a'.repeat(MAX_IDENTIFIER_LENGTH), readIdentifier).issues).toEqual([]);
  });

  it.each([
    '',
    ' a',
    'a b',
    'a.b',
    'a->b',
    'é',
    'a\n',
    '😀',
    'a'.repeat(MAX_IDENTIFIER_LENGTH + 1),
  ])('rejects %j', (value) => {
    expect(run(value, readIdentifier)).toEqual({
      result: undefined,
      issues: [{ path: PATH, code: 'INVALID_IDENTIFIER' }],
    });
  });

  it('rejects a missing value and other types', () => {
    expect(codes(undefined, readIdentifier)).toEqual(['MISSING_FIELD']);
    expect(codes(12, readIdentifier)).toEqual(['WRONG_TYPE']);
  });
});

describe('readPatternString', () => {
  /** Reads a short text of lowercase letters. */
  const read = (field: Field, issues: IssueList): unknown =>
    readPatternString(field, issues, /^[a-z]+$/, 3);

  it('requires a full match within the length', () => {
    expect(run('abc', read).result).toBe('abc');
    expect(codes('abcd', read)).toEqual(['INVALID_IDENTIFIER']);
    expect(codes('ab1', read)).toEqual(['INVALID_IDENTIFIER']);
  });
});

describe('readNullable', () => {
  it('accepts null without calling the inner reader', () => {
    expect(run(null, (field, issues) => readNullable(field, issues, readBoolean))).toEqual({
      result: null,
      issues: [],
    });
  });

  it('delegates any other value to the inner reader', () => {
    /** Reads a true or false value that may be null. */
    const read = (field: Field, issues: IssueList): unknown =>
      readNullable(field, issues, readBoolean);
    expect(run(true, read).result).toBe(true);
    expect(codes('yes', read)).toEqual(['WRONG_TYPE']);
    expect(codes(undefined, read)).toEqual(['MISSING_FIELD']);
  });
});

describe('readRawString', () => {
  it('accepts any string, even empty or with control characters', () => {
    expect(run('', readRawString).result).toBe('');
    expect(run('\u0000', readRawString).result).toBe('\u0000');
    expect(codes(null, readRawString)).toEqual(['WRONG_TYPE']);
    expect(codes(undefined, readRawString)).toEqual(['MISSING_FIELD']);
  });
});
