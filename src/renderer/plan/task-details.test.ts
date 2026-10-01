import { describe, expect, it } from 'vitest';
import { at } from '../../core/testing/civil-time';
import {
  blockLink,
  link,
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import {
  draftFromTask,
  taskBasis,
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

const NO_WAITS = (): string => '';

describe('draftFromTask and taskFromDraft', () => {
  it('fills the panel from a split task and builds the same task back', () => {
    const draft = draftFromTask(SPLIT, NO_WAITS, '');
    expect(draft).toEqual({
      name: 's',
      tagId: 'design',
      progress: '30',
      start: '2026-10-05T09:30',
      hoursPerDay: '4 h 30',
      dailyStart: '13:15',
      blocks: [
        { duration: '7 h', gapDays: '0', origin: 0, waitsFor: '' },
        { duration: '3 h 30', gapDays: '2', origin: 1, waitsFor: '' },
      ],
      basis: '',
    });
    expect(taskFromDraft(SPLIT, draft, 9)).toEqual({ ok: true, value: SPLIT });
  });

  it('builds the same milestone and summary back', () => {
    const point = milestone('m', { startNoEarlierThan: at(2026, 10, 5, 12) });
    expect(taskFromDraft(point, draftFromTask(point, NO_WAITS, ''), 9)).toEqual({
      ok: true,
      value: point,
    });
    const group = summary('g', { name: 'Phase' });
    expect(
      taskFromDraft(group, { ...draftFromTask(group, NO_WAITS, ''), name: ' Stage ' }, 9),
    ).toEqual({
      ok: true,
      value: { ...group, name: 'Stage' },
    });
  });

  it('adds a block of a working day a day later, and removes blocks down to one', () => {
    const task = workTask('w');
    const added = withAddedBlock(draftFromTask(task, NO_WAITS, ''), 9);
    expect(added.blocks).toEqual([
      { duration: '7 h', gapDays: '0', origin: 0, waitsFor: '' },
      { duration: '9 h', gapDays: '1', origin: null, waitsFor: '' },
    ]);
    const built = taskFromDraft(task, added, 9);
    expect(built.ok && built.value.kind === 'task' && built.value.segments).toEqual([
      { durationHours: 7, gapDaysBefore: 0 },
      { durationHours: 9, gapDaysBefore: 1 },
    ]);
    const first = withoutBlock(added, 0);
    expect(first.blocks).toEqual([{ duration: '9 h', gapDays: '0', origin: null, waitsFor: '' }]);
    expect(withoutBlock(first, 0)).toBe(first);
  });

  it('accepts a block resuming the same day, and fills what each block waits for', () => {
    const draft = draftFromTask(SPLIT, (block) => (block === 1 ? '2, 3#1SS' : ''), '');
    expect(draft.blocks.map((block) => block.waitsFor)).toEqual(['', '2, 3#1SS']);
    const sameDay = {
      ...draft,
      blocks: draft.blocks.map((block) => ({ ...block, gapDays: '0' })),
    };
    const built = taskFromDraft(SPLIT, sameDay, 9);
    expect(built.ok && built.value.kind === 'task' && built.value.segments[1]).toEqual({
      durationHours: 3.5,
      gapDaysBefore: 0,
    });
  });

  it('drops the daily start time of a task that works whole days', () => {
    const draft: TaskDraft = { ...draftFromTask(SPLIT, NO_WAITS, ''), hoursPerDay: '' };
    expect(taskFromDraft(SPLIT, draft, 9)).toMatchObject({
      ok: true,
      value: { hoursPerDay: null, dailyStartHour: null },
    });
  });

  it('clears the optional fields when they are left empty', () => {
    const draft: TaskDraft = {
      ...draftFromTask(SPLIT, NO_WAITS, ''),
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
    [
      'an empty block',
      { blocks: [{ duration: '', gapDays: '0', origin: 0, waitsFor: '' }] },
      'INVALID_BLOCK',
    ],
    ['no block at all', { blocks: [] }, 'INVALID_BLOCK'],
    [
      'a gap that is not a whole number of days',
      {
        blocks: [
          { duration: '1 h', gapDays: '0', origin: 0, waitsFor: '' },
          { duration: '1 h', gapDays: '1.5', origin: 1, waitsFor: '' },
        ],
      },
      'INVALID_GAP',
    ],
  ])('refuses %s', (_label, change, error) => {
    expect(taskFromDraft(SPLIT, { ...draftFromTask(SPLIT, NO_WAITS, ''), ...change }, 9)).toEqual({
      ok: false,
      error,
    });
  });
});

describe('taskBasis', () => {
  it('changes when the task or one of its links changes, and only then', () => {
    const plan = project([SPLIT, workTask('w'), workTask('x')], [link('w', 's')]);
    const basis = taskBasis(plan, 's');
    expect(taskBasis({ ...plan, dependencies: [...plan.dependencies].reverse() }, 's')).toBe(basis);
    expect(taskBasis({ ...plan, dependencies: [...plan.dependencies, link('w', 'x')] }, 's')).toBe(
      basis,
    );
    expect(
      taskBasis(
        { ...plan, dependencies: [...plan.dependencies, blockLink('x', 's', { to: 1 })] },
        's',
      ),
    ).not.toBe(basis);
    expect(
      taskBasis(
        { ...plan, tasks: plan.tasks.map((task) => ({ ...task, name: `${task.name}!` })) },
        's',
      ),
    ).not.toBe(basis);
  });
});
