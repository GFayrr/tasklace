import { MAX_IDENTIFIER_LENGTH } from './limits';
import type { DependencyId, TagId, TaskId } from './model/project';

export type NewIdentifier = TaskId & DependencyId & TagId;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Tells whether a value is an identifier of the project, letters, digits, hyphens and underscores within the length limit, which may then name a task, a link or a tag. */
export function isIdentifier(value: unknown): value is NewIdentifier {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

/** Gives a value known to be an identifier, such as a newly generated one, as an identifier, throwing for any other value since only a programming error can give one. */
export function requireIdentifier(value: unknown): NewIdentifier {
  if (!isIdentifier(value)) {
    throw new TypeError(`Not an identifier: ${String(value)}`);
  }
  return value;
}
