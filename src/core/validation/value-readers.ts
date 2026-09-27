import { MAX_IDENTIFIER_LENGTH } from '../limits';
import type { IssueList } from './validation-issues';

export interface Field {
  readonly value: unknown;
  readonly path: string;
}

export type UnknownRecord = Readonly<Record<string, unknown>>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const LAST_C0_CONTROL = 0x1f;
const FIRST_C1_CONTROL = 0x7f;
const LAST_C1_CONTROL = 0x9f;

/** Reads a child field of a record by its own property name, never through the prototype chain. */
export function childField(record: UnknownRecord, key: string, parentPath: string): Field {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return { value, path: parentPath === '' ? key : `${parentPath}.${key}` };
}

/** Reads the element of an array at a given index. */
export function itemField(items: readonly unknown[], index: number, parentPath: string): Field {
  return { value: items[index], path: `${parentPath}[${String(index)}]` };
}

/** Reads a plain object and reports every property that is not in the allowed list. */
export function readRecord(
  field: Field,
  issues: IssueList,
  allowedKeys: readonly string[],
): UnknownRecord | undefined {
  const record = readPlainObject(field, issues);
  if (record !== undefined) {
    reportUnknownKeys(record, field.path, issues, allowedKeys);
  }
  return record;
}

/** Reads a plain object without looking at its properties. */
export function readPlainObject(field: Field, issues: IssueList): UnknownRecord | undefined {
  if (!isPresent(field, issues)) {
    return undefined;
  }
  if (!isPlainObject(field.value)) {
    issues.add(field.path, 'WRONG_TYPE');
    return undefined;
  }
  return field.value;
}

/** Reports every property of a record that is not in the allowed list. */
export function reportUnknownKeys(
  record: UnknownRecord,
  path: string,
  issues: IssueList,
  allowedKeys: readonly string[],
): void {
  for (const key of Object.keys(record).filter((key) => !allowedKeys.includes(key))) {
    issues.add(`${path === '' ? '' : `${path}.`}${key}`, 'UNKNOWN_FIELD');
  }
}

/** Reads an array holding at most a given number of items. */
export function readArray(
  field: Field,
  issues: IssueList,
  maxItems: number,
): readonly unknown[] | undefined {
  if (!isPresent(field, issues)) {
    return undefined;
  }
  if (!Array.isArray(field.value)) {
    issues.add(field.path, 'WRONG_TYPE');
    return undefined;
  }
  if (field.value.length > maxItems) {
    issues.add(field.path, 'TOO_MANY_ITEMS');
    return undefined;
  }
  return field.value as readonly unknown[];
}

/** Reads a whole number between two bounds, both included. */
export function readInteger(
  field: Field,
  issues: IssueList,
  min: number,
  max: number,
): number | undefined {
  if (!isPresent(field, issues)) {
    return undefined;
  }
  if (typeof field.value !== 'number' || !Number.isInteger(field.value)) {
    issues.add(field.path, 'WRONG_TYPE');
    return undefined;
  }
  if (field.value < min || field.value > max) {
    issues.add(field.path, 'OUT_OF_RANGE');
    return undefined;
  }
  return field.value;
}

/** Reads a boolean. */
export function readBoolean(field: Field, issues: IssueList): boolean | undefined {
  if (!isPresent(field, issues)) {
    return undefined;
  }
  if (typeof field.value !== 'boolean') {
    issues.add(field.path, 'WRONG_TYPE');
    return undefined;
  }
  return field.value;
}

/** Reads one value out of a fixed list of allowed strings. */
export function readEnum<T extends string>(
  field: Field,
  issues: IssueList,
  allowed: readonly T[],
): T | undefined {
  const text = readRawString(field, issues);
  if (text === undefined) {
    return undefined;
  }
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) {
    issues.add(field.path, 'OUT_OF_RANGE');
  }
  return match;
}

/** Reads a user text: non-empty once trimmed, without control characters, within a length counted in Unicode code points so that the bound on stored size does not depend on the UTF-16 encoding. */
export function readText(field: Field, issues: IssueList, maxLength: number): string | undefined {
  const text = readRawString(field, issues);
  if (text === undefined) {
    return undefined;
  }
  if (!text.isWellFormed() || hasControlCharacter(text)) {
    issues.add(field.path, 'INVALID_TEXT');
    return undefined;
  }
  if (text.trim() === '') {
    issues.add(field.path, 'EMPTY_TEXT');
    return undefined;
  }
  if (Array.from(text).length > maxLength) {
    issues.add(field.path, 'TOO_LONG');
    return undefined;
  }
  return text;
}

/** Reads an identifier made of letters, digits, dashes and underscores. */
export function readIdentifier(field: Field, issues: IssueList): string | undefined {
  return readPatternString(field, issues, IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH);
}

/** Reads a string that must fully match a pattern and stay within a length. */
export function readPatternString(
  field: Field,
  issues: IssueList,
  pattern: RegExp,
  maxLength: number,
): string | undefined {
  const text = readRawString(field, issues);
  if (text === undefined) {
    return undefined;
  }
  if (text.length > maxLength || !pattern.test(text)) {
    issues.add(field.path, 'INVALID_IDENTIFIER');
    return undefined;
  }
  return text;
}

/** Reads a value that may be null, using another reader otherwise; undefined means invalid. */
export function readNullable<T>(
  field: Field,
  issues: IssueList,
  read: (field: Field, issues: IssueList) => T | undefined,
): T | null | undefined {
  return field.value === null ? null : read(field, issues);
}

/** Reads any string, reporting a missing field or a wrong type. */
export function readRawString(field: Field, issues: IssueList): string | undefined {
  if (!isPresent(field, issues)) {
    return undefined;
  }
  if (typeof field.value !== 'string') {
    issues.add(field.path, 'WRONG_TYPE');
    return undefined;
  }
  return field.value;
}

/** Tells whether a text contains a control character such as a line break or a null character. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL)) {
      return true;
    }
  }
  return false;
}

/** Reports a missing field and tells whether the field is present. */
function isPresent(field: Field, issues: IssueList): boolean {
  if (field.value === undefined) {
    issues.add(field.path, 'MISSING_FIELD');
    return false;
  }
  return true;
}

/** Tells whether a value is a plain object, as produced by JSON parsing. */
function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
