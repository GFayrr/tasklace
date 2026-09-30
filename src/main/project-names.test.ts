import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH } from '../core/limits';
import { toProjectHour } from '../core/time';
import { localProjectHour, projectNameFromPath } from './project-names';

const FALLBACK = 'Untitled project';

describe('projectNameFromPath', () => {
  it.each([
    ['/projects/Plan 2027.csv', 'Plan 2027'],
    ['/projects/archive.v2.json', 'archive.v2'],
    ['/projects/Été\u0007.csv', 'Été'],
    ['/projects/.csv', '.csv'],
    ['/projects/   .json', FALLBACK],
  ])('names %j %j', (path, expected) => {
    expect(projectNameFromPath(path, FALLBACK)).toBe(expected);
  });

  it('keeps a name within the length of a project name, counting characters rather than code units', () => {
    const name = projectNameFromPath(
      `/p/${'😀'.repeat(MAX_PROJECT_NAME_LENGTH + 5)}.csv`,
      FALLBACK,
    );
    expect(Array.from(name)).toHaveLength(MAX_PROJECT_NAME_LENGTH);
  });
});

describe('localProjectHour', () => {
  it('reads the local date and hour of a moment', () => {
    const moment = new Date(2026, 8, 30, 14, 35);
    const expected = toProjectHour({ year: 2026, month: 9, day: 30, hour: 14 });
    expect(expected.ok && localProjectHour(moment, 0)).toBe(expected.ok && expected.value);
  });

  it('falls back outside the supported years', () => {
    expect(localProjectHour(new Date(1999, 0, 1), 42)).toBe(42);
  });
});
