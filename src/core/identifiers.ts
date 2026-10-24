import { MAX_IDENTIFIER_LENGTH } from './limits';
import type { DependencyId, TagId, TaskId } from './model/project';

export type NewIdentifier = TaskId & DependencyId & TagId;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Tells whether a value has the form of an identifier of the project: letters, digits, hyphens and underscores within the length limit. */
export function isIdentifierText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

/** Tells whether a value can identify a task. */
export function isTaskId(value: unknown): value is TaskId {
  return isIdentifierText(value);
}

/** Tells whether a value can identify a tag. */
export function isTagId(value: unknown): value is TagId {
  return isIdentifierText(value);
}

/** Tells whether a value can identify a dependency. */
export function isDependencyId(value: unknown): value is DependencyId {
  return isIdentifierText(value);
}

/** Gives a value known to be an identifier, such as a newly generated one, as an identifier, throwing for any other value since only a programming error can give one. */
export function requireIdentifier(value: unknown): NewIdentifier {
  if (!isNewIdentifier(value)) {
    throw new TypeError(`Not an identifier: ${String(value)}`);
  }
  return value;
}

/** Tells whether a value can name a new task, link or tag, which only a creation may do. */
function isNewIdentifier(value: unknown): value is NewIdentifier {
  return isIdentifierText(value);
}
