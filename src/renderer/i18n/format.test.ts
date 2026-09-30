import { describe, expect, it } from 'vitest';
import { project, scheduleOrThrow, workTask, link } from '../../core/testing/project-builder';
import { at } from '../../core/testing/civil-time';
import { createDayFormatter, projectSpan } from './format';

describe('createDayFormatter', () => {
  it('writes the wall-clock day whatever the time zone of the computer', () => {
    expect(createDayFormatter('en-US')(at(2026, 10, 5, 23))).toBe('Oct 5, 2026');
    expect(createDayFormatter('fr-FR')(at(2026, 10, 5, 0))).toBe('5 oct. 2026');
  });
});

describe('projectSpan', () => {
  it('spans from the earliest start to the latest end', () => {
    const plan = project([workTask('a'), workTask('b')], [link('a', 'b')]);
    const schedule = scheduleOrThrow(plan);
    const span = projectSpan(schedule);
    expect(span?.start).toBe(schedule.placements.get('a')?.start);
    expect(span?.end).toBe(schedule.placements.get('b')?.end);
  });

  it('is empty for a schedule without tasks', () => {
    expect(projectSpan(scheduleOrThrow(project([])))).toBeNull();
  });
});
