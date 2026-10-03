import { describe, expect, it } from 'vitest';
import { TEST_CALENDAR } from '../../core/testing/test-calendar';
import { compileOrThrow } from '../../core/testing/civil-time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { loadMessages } from '../i18n/messages';
import { createTableFormatters, taskCells } from './table-format';

const messages = await loadMessages('en');
const FORMATTERS = createTableFormatters('en-US');
const CALENDAR = compileOrThrow(TEST_CALENDAR);
const PLAN = project(
  [
    summary('s'),
    workTask('a', { parentId: 's', progressPercent: 40 }),
    workTask('b', {
      parentId: 's',
      segments: [{ durationHours: 14, gapDaysBefore: 0, startNoEarlierThan: null }],
    }),
    milestone('m'),
  ],
  [link('a', 'b'), link('b', 'm')],
);
const SCHEDULE = scheduleOrThrow(PLAN);

/** Returns the task of the sample plan with an identifier. */
function taskOf(id: string) {
  const task = PLAN.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(id);
  }
  return task;
}

describe('taskCells', () => {
  it('writes the hours, dates and progress of a work task with ISO dates the same on every computer and regional numbers', () => {
    expect(taskCells(taskOf('a'), SCHEDULE, CALENDAR, FORMATTERS, messages)).toEqual({
      duration: '7 h',
      start: '2026-09-28 09:00',
      end: '2026-09-28 17:00',
      progress: '40%',
    });
  });

  it('gives a summary the working hours between its dates and its weighted progress', () => {
    expect(taskCells(taskOf('s'), SCHEDULE, CALENDAR, FORMATTERS, messages)).toEqual({
      duration: '21 h',
      start: '2026-09-28 09:00',
      end: '2026-09-30 17:00',
      progress: '13%',
    });
  });

  it('gives a milestone no duration, and leaves dates empty until the schedule is known', () => {
    expect(taskCells(taskOf('m'), null, CALENDAR, FORMATTERS, messages)).toEqual({
      duration: '0 h',
      start: '',
      end: '',
      progress: '0%',
    });
    expect(taskCells(taskOf('s'), null, null, FORMATTERS, messages).start).toBe('');
  });

  it('leaves the duration of a summary empty without a calendar', () => {
    expect(taskCells(taskOf('s'), SCHEDULE, null, FORMATTERS, messages)).toEqual({
      duration: '',
      start: '2026-09-28 09:00',
      end: '2026-09-30 17:00',
      progress: '13%',
    });
  });

  it('gives a summary of key dates alone the progress of its milestones, and an empty summary no cells', () => {
    const keyDates = project([
      summary('k'),
      milestone('x', { parentId: 'k', progressPercent: 100 }),
      milestone('y', { parentId: 'k' }),
      summary('e'),
    ]);
    const [withMilestones, , , empty] = keyDates.tasks;
    if (withMilestones === undefined || empty === undefined) {
      throw new Error('Missing summary');
    }
    const schedule = scheduleOrThrow(keyDates);
    expect(taskCells(withMilestones, schedule, CALENDAR, FORMATTERS, messages).progress).toBe(
      '50%',
    );
    expect(taskCells(empty, schedule, CALENDAR, FORMATTERS, messages)).toEqual({
      duration: '',
      start: '',
      end: '',
      progress: '',
    });
  });
});
