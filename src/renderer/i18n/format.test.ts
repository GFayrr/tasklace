import { describe, expect, it } from 'vitest';
import { project, scheduleOrThrow, workTask, link } from '../../core/testing/project-builder';
import { at } from '../../core/testing/civil-time';
import type { Weekday } from '../../core/time';
import {
  createDayFormatter,
  createPeriodFormatter,
  createWeekdayNamer,
  projectSpan,
} from './format';

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

describe('createWeekdayNamer', () => {
  it('names each weekday in the language of the system', () => {
    const english = createWeekdayNamer('en-US');
    const week: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
    expect(week.map((day) => english(day))).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(createWeekdayNamer('fr-FR')(1)).toBe('lun.');
  });
});

describe('createPeriodFormatter', () => {
  it('writes a period with its days and times, the day once when both ends fall on it', () => {
    const format = createPeriodFormatter('en-GB');
    expect(format(at(2026, 10, 13, 10), at(2026, 10, 15, 12))).toBe(
      'Tue 13 Oct, 10:00\u2009–\u2009Thu 15 Oct, 12:00',
    );
    expect(format(at(2026, 10, 26, 14), at(2026, 10, 26, 16))).toBe('Mon 26 Oct, 14:00–16:00');
  });
});
