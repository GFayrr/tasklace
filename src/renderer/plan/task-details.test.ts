import { describe, expect, it } from 'vitest';
import { at } from '../../core/testing/civil-time';
import { milestone, splitTask, summary, workTask } from '../../core/testing/project-builder';
import {
  draftFromTask,
  taskFromDraft,
  withAddedBlock,
  withoutBlock,
  type TaskDraft,
} from './task-details';

const SPLIT = splitTask(
  's',
  [
    [7, 0],
    [3.5, 2],
  ],
  {
    tagId: 'design',
    progressPercent: 30,
    startNoEarlierThan: at(2026, 10, 5, 9) + 0.5,
    hoursPerDay: 4.5,
    dailyStartHour: 13.25,
  },
);

describe('draftFromTask and taskFromDraft', () => {
  it('fills the panel from a split task and builds the same task back', () => {
    const draft = draftFromTask(SPLIT);
    expect(draft).toEqual({
      name: 's',
      tagId: 'design',
      progress: '30',
      start: '2026-10-05T09:30',
      hoursPerDay: '4 h 30',
      dailyStart: '13:15',
      blocks: [
        { duration: '7 h', gapDays: '0' },
        { duration: '3 h 30', gapDays: '2' },
      ],
    });
    expect(taskFromDraft(SPLIT, draft, 9)).toEqual({ ok: true, value: SPLIT });
  });

  it('builds the same milestone and summary back', () => {
    const point = milestone('m', { startNoEarlierThan: at(2026, 10, 5, 12) });
    expect(taskFromDraft(point, draftFromTask(point), 9)).toEqual({ ok: true, value: point });
    const group = summary('g', { name: 'Phase' });
    expect(taskFromDraft(group, { ...draftFromTask(group), name: ' Stage ' }, 9)).toEqual({
      ok: true,
      value: { ...group, name: 'Stage' },
    });
  });

  it('adds a block of a working day a day later, and removes blocks down to one', () => {
    const task = workTask('w');
    const added = withAddedBlock(draftFromTask(task), 9);
    expect(added.blocks).toEqual([
      { duration: '7 h', gapDays: '0' },
      { duration: '9 h', gapDays: '1' },
    ]);
    const built = taskFromDraft(task, added, 9);
    expect(built.ok && built.value.kind === 'task' && built.value.segments).toEqual([
      { durationHours: 7, gapDaysBefore: 0 },
      { durationHours: 9, gapDaysBefore: 1 },
    ]);
    const first = withoutBlock(added, 0);
    expect(first.blocks).toEqual([{ duration: '9 h', gapDays: '0' }]);
    expect(withoutBlock(first, 0)).toBe(first);
  });

  it('drops the daily start time of a task that works whole days', () => {
    const draft: TaskDraft = { ...draftFromTask(SPLIT), hoursPerDay: '' };
    expect(taskFromDraft(SPLIT, draft, 9)).toMatchObject({
      ok: true,
      value: { hoursPerDay: null, dailyStartHour: null },
    });
  });

  it('clears the optional fields when they are left empty', () => {
    const draft: TaskDraft = {
      ...draftFromTask(SPLIT),
      start: '',
      hoursPerDay: '',
      dailyStart: '',
    };
    expect(taskFromDraft(SPLIT, draft, 9)).toMatchObject({
      ok: true,
      value: { startNoEarlierThan: null, hoursPerDay: null, dailyStartHour: null },
    });
  });

  it.each<[string, Partial<TaskDraft>, string]>([
    ['an empty name', { name: '  ' }, 'INVALID_NAME'],
    ['a progress above 100', { progress: '101' }, 'INVALID_PROGRESS'],
    ['a progress with decimals', { progress: '4.5' }, 'INVALID_PROGRESS'],
    ['an unreadable start', { start: 'soon' }, 'INVALID_DATE'],
    ['less than an hour a day', { hoursPerDay: '30 min' }, 'INVALID_HOURS_PER_DAY'],
    ['unreadable hours per day', { hoursPerDay: 'many' }, 'INVALID_HOURS_PER_DAY'],
    ['a daily start off the quarter hour', { dailyStart: '13:10' }, 'INVALID_DAILY_START'],
    ['a daily start past midnight', { dailyStart: '24:00' }, 'INVALID_DAILY_START'],
    ['an empty block', { blocks: [{ duration: '', gapDays: '0' }] }, 'INVALID_BLOCK'],
    ['no block at all', { blocks: [] }, 'INVALID_BLOCK'],
    [
      'a gap of no day',
      {
        blocks: [
          { duration: '1 h', gapDays: '0' },
          { duration: '1 h', gapDays: '0' },
        ],
      },
      'INVALID_GAP',
    ],
  ])('refuses %s', (_label, change, error) => {
    expect(taskFromDraft(SPLIT, { ...draftFromTask(SPLIT), ...change }, 9)).toEqual({
      ok: false,
      error,
    });
  });
});
