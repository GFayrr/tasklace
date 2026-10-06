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
import { at } from '../../core/testing/civil-time';
import { createTableFormatters, dateConflictTitles, floatCells, taskCells } from './table-format';

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

describe('floatCells', () => {
  it('writes known, negative and unknown floats, and nothing without floats', () => {
    const known = {
      lateStart: 0,
      lateFinish: 1,
      totalFloatHours: 8.25,
      freeFloatHours: 0,
      isCritical: false,
    };
    expect(floatCells(known, FORMATTERS, messages)).toEqual({
      total: '8 h 15',
      free: '0 h',
      isCritical: false,
      isUnknown: false,
    });
    expect(
      floatCells({ ...known, totalFloatHours: -3, isCritical: true }, FORMATTERS, messages),
    ).toEqual({ total: '\u22123 h', free: '0 h', isCritical: true, isUnknown: false });
    expect(
      floatCells(
        {
          lateStart: null,
          lateFinish: null,
          totalFloatHours: null,
          freeFloatHours: null,
          isCritical: true,
        },
        FORMATTERS,
        messages,
      ),
    ).toEqual({ total: '?', free: '?', isCritical: true, isUnknown: true });
    expect(floatCells(undefined, FORMATTERS, messages)).toEqual({
      total: '',
      free: '',
      isCritical: false,
      isUnknown: false,
    });
  });
});

describe('dateConflictTitles', () => {
  const moment = (hour: number) => `@${String(hour - at(2026, 10, 23))}`;

  it('names every date a task misses, in one tooltip per task', () => {
    const end = at(2026, 10, 23, 17);
    const titles = dateConflictTitles(
      [
        {
          conflict: { code: 'DEADLINE_MISSED', taskId: 'a' },
          taskName: 'A',
          end,
          date: at(2026, 10, 23, 12),
        },
        {
          conflict: { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'a' },
          taskName: 'A',
          end,
          date: at(2026, 10, 23, 10),
        },
        {
          conflict: { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'b' },
          taskName: 'B',
          end,
          date: at(2026, 10, 23, 9),
        },
      ],
      messages,
      moment,
    );
    expect([...titles]).toEqual([
      [
        'a',
        'Ends at @17, after its deadline (@12). Cannot finish on @10: it ends at @17 at the earliest.',
      ],
      ['b', 'Cannot finish on @9: it ends at @17 at the earliest.'],
    ]);
    expect(dateConflictTitles([], messages, moment).size).toBe(0);
  });
});
