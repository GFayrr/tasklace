import { describe, expect, it } from 'vitest';
import { MAX_IDENTIFIER_LENGTH } from './limits';
import {
  isDependencyId,
  isIdentifierText,
  isTagId,
  isTaskId,
  requireIdentifier,
} from './identifiers';
import type { DependencyId, TagId, TaskId } from './model/project';
import type { DayIndex, ProjectHour } from './time';

describe('identifiers', () => {
  it('accepts letters, digits, hyphens and underscores within the length limit, and nothing else', () => {
    expect(
      [
        'a',
        'Task_1-b',
        'x'.repeat(MAX_IDENTIFIER_LENGTH),
        'x'.repeat(MAX_IDENTIFIER_LENGTH + 1),
        '',
        'a b',
        '../a',
        'é',
        42,
        null,
      ].map(isIdentifierText),
    ).toEqual([true, true, true, false, false, false, false, false, false, false]);
  });

  it('reads each kind of identifier with the same rule, keeping its kind', () => {
    const values: unknown[] = ['t1', 'a b', 42];
    expect([values.map(isTaskId), values.map(isTagId), values.map(isDependencyId)]).toEqual([
      [true, false, false],
      [true, false, false],
      [true, false, false],
    ]);
    const read: unknown = 't1';
    if (isTaskId(read)) {
      // @ts-expect-error A value read as a task identifier is not a tag identifier.
      const tag: TagId = read;
      expect(tag).toBe('t1');
    }
  });

  it('gives a valid identifier as one, and throws for any other value', () => {
    expect(requireIdentifier('t1')).toBe('t1');
    expect(() => requireIdentifier('a b')).toThrow(new TypeError('Not an identifier: a b'));
  });
});

describe('the kinds of identifiers and of times', () => {
  it('keeps the identifiers of tasks, links and tags apart, and days apart from hours, when the code is compiled', () => {
    const task: TaskId = requireIdentifier('a');
    const day: DayIndex = 20_724;
    // @ts-expect-error A task identifier is not a tag identifier.
    const tag: TagId = task;
    // @ts-expect-error A task identifier is not a link identifier.
    const link: DependencyId = task;
    // @ts-expect-error A day is not an hour of the project.
    const hour: ProjectHour = day;
    expect([tag, link, hour]).toEqual(['a', 'a', 20_724]);
  });
});
