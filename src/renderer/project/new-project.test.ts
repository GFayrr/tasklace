import { describe, expect, it } from 'vitest';
import { readProject, STORED_VALUE_CODEC } from '../../core/validation/read-project';
import { at } from '../../core/testing/civil-time';
import { MIN_PROJECT_HOUR } from '../../core/time';
import { buildNewProject, localDayStart, localHourOf, localQuarterOf } from './new-project';

describe('buildNewProject', () => {
  it('builds a valid empty project starting at midnight of the local day, with the default tags', () => {
    let next = 0;
    const built = buildNewProject(
      'Plan',
      new Date(2026, 9, 5, 15, 42),
      () => `tag-${String(next++)}`,
    );
    expect(built.startDate).toBe(at(2026, 10, 5, 0));
    expect(built.tags.map((tag) => tag.name)).toEqual([
      'Design',
      'Development',
      'Testing',
      'Deployment',
      'Documentation',
    ]);
    expect(readProject(built, STORED_VALUE_CODEC).ok).toBe(true);
  });

  it('falls back to the first supported hour for a clock outside the supported years', () => {
    expect(localDayStart(new Date(1900, 0, 1))).toBe(MIN_PROJECT_HOUR);
    expect(localHourOf(new Date(1900, 0, 1))).toBe(MIN_PROJECT_HOUR);
  });

  it('reads the local hour of a moment', () => {
    expect(localHourOf(new Date(2026, 9, 5, 15, 42))).toBe(at(2026, 10, 5, 15));
  });

  it('reads the local quarter hour of a moment, rounded down', () => {
    expect(localQuarterOf(new Date(2026, 9, 5, 15, 42))).toBe(at(2026, 10, 5, 15) + 0.5);
    expect(localQuarterOf(new Date(2026, 9, 5, 15, 0))).toBe(at(2026, 10, 5, 15));
    expect(localQuarterOf(new Date(2026, 9, 5, 15, 59))).toBe(at(2026, 10, 5, 15) + 0.75);
    expect(localQuarterOf(new Date(1900, 0, 1, 15, 59))).toBeNull();
    expect(localQuarterOf(new Date(Number.NaN))).toBeNull();
  });
});
