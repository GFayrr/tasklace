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
  findUnreadableBlockStart,
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
const ON = {
  criticalPathEnabled: false,
  dateConstraintsEnabled: true,
  baselineEnabled: false,
  alwaysShowPatterns: false,
};
const OFF = { ...ON, dateConstraintsEnabled: false };

describe('draftFromTask and taskFromDraft', () => {
  it('fills the panel from a split task and builds the same task back', () => {
    const draft = draftFromTask(SPLIT, NO_WAITS, '');
    expect(draft).toEqual({
      name: 's',
      tagId: 'design',
      progress: '30',
      start: '2026-10-05T09:30',
      mustFinishOn: '',
      deadline: '',
      hoursPerDay: '4 h 30',
      dailyStart: '13:15',
      blocks: [
        { duration: '7 h', gapDays: '0', start: '', origin: 0, waitsFor: '' },
        { duration: '3 h 30', gapDays: '2', start: '', origin: 1, waitsFor: '' },
      ],
      basis: '',
    });
    expect(taskFromDraft(SPLIT, draft, 9, ON)).toEqual({ ok: true, value: SPLIT });
  });

  it('builds the same milestone and summary back', () => {
    const point = milestone('m', { startNoEarlierThan: at(2026, 10, 5, 12) });
    expect(taskFromDraft(point, draftFromTask(point, NO_WAITS, ''), 9, ON)).toEqual({
      ok: true,
      value: point,
    });
    const group = summary('g', { name: 'Phase' });
    expect(
      taskFromDraft(group, { ...draftFromTask(group, NO_WAITS, ''), name: ' Stage ' }, 9, ON),
    ).toEqual({
      ok: true,
      value: { ...group, name: 'Stage' },
    });
  });

  it('adds a block of a working day a day later, and removes blocks down to one', () => {
    const task = workTask('w');
    const added = withAddedBlock(draftFromTask(task, NO_WAITS, ''), 9);
    expect(added.blocks).toEqual([
      { duration: '7 h', gapDays: '0', start: '', origin: 0, waitsFor: '' },
      { duration: '9 h', gapDays: '1', start: '', origin: null, waitsFor: '' },
    ]);
    const built = taskFromDraft(task, added, 9, ON);
    expect(built.ok && built.value.kind === 'task' && built.value.segments).toEqual([
      { durationHours: 7, gapDaysBefore: 0, startNoEarlierThan: null },
      { durationHours: 9, gapDaysBefore: 1, startNoEarlierThan: null },
    ]);
    const first = withoutBlock(added, 0);
    expect(first.blocks).toEqual([
      { duration: '9 h', gapDays: '0', start: '', origin: null, waitsFor: '' },
    ]);
    expect(withoutBlock(first, 0)).toBe(first);
  });

  it('accepts a block resuming the same day, and fills what each block waits for', () => {
    const draft = draftFromTask(SPLIT, (block) => (block === 1 ? '2, 3#1SS' : ''), '');
    expect(draft.blocks.map((block) => block.waitsFor)).toEqual(['', '2, 3#1SS']);
    const sameDay = {
      ...draft,
      blocks: draft.blocks.map((block) => ({ ...block, gapDays: '0' })),
    };
    const built = taskFromDraft(SPLIT, sameDay, 9, ON);
    expect(built.ok && built.value.kind === 'task' && built.value.segments[1]).toEqual({
      durationHours: 3.5,
      gapDaysBefore: 0,
      startNoEarlierThan: null,
    });
  });

  it('drops the daily start time of a task that works whole days', () => {
    const draft: TaskDraft = { ...draftFromTask(SPLIT, NO_WAITS, ''), hoursPerDay: '' };
    expect(taskFromDraft(SPLIT, draft, 9, ON)).toMatchObject({
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
    expect(taskFromDraft(SPLIT, draft, 9, ON)).toMatchObject({
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
      { blocks: [{ duration: '', gapDays: '0', start: '', origin: 0, waitsFor: '' }] },
      'INVALID_BLOCK',
    ],
    ['no block at all', { blocks: [] }, 'INVALID_BLOCK'],
    [
      'a gap that is not a whole number of days',
      {
        blocks: [
          { duration: '1 h', gapDays: '0', start: '', origin: 0, waitsFor: '' },
          { duration: '1 h', gapDays: '1.5', start: '', origin: 1, waitsFor: '' },
        ],
      },
      'INVALID_GAP',
    ],
  ])('refuses %s', (_label, change, error) => {
    expect(
      taskFromDraft(SPLIT, { ...draftFromTask(SPLIT, NO_WAITS, ''), ...change }, 9, ON),
    ).toEqual({
      ok: false,
      error,
    });
  });
});

describe('block start dates in the details panel', () => {
  it('reads and writes the start date of a later block, and refuses one that cannot be read', () => {
    const dated = splitTask('d', [
      [7, 0],
      [7, 1, at(2026, 10, 6, 13) + 0.25],
    ]);
    const draft = draftFromTask(dated, NO_WAITS, '');
    expect(draft.blocks.map((block) => block.start)).toEqual(['', '2026-10-06T13:15']);
    expect(taskFromDraft(dated, draft, 9, ON)).toEqual({ ok: true, value: dated });
    const unreadable = {
      ...draft,
      blocks: draft.blocks.map((block, index) =>
        index === 1 ? { ...block, start: 'soon' } : block,
      ),
    };
    expect(taskFromDraft(dated, unreadable, 9, ON)).toEqual({ ok: false, error: 'INVALID_DATE' });
    expect(findUnreadableBlockStart(unreadable)).toBe(1);
    expect(findUnreadableBlockStart(draft)).toBeNull();
  });

  it('keeps for the task the later of its start date and that of the block that becomes the first', () => {
    const dated = splitTask('d', [
      [7, 0],
      [7, 1, at(2026, 10, 6, 13)],
    ]);
    const draft = draftFromTask(dated, NO_WAITS, '');
    const remaining = withoutBlock(draft, 0);
    expect(remaining.start).toBe('2026-10-06T13:00');
    expect(remaining.blocks).toEqual([
      { duration: '7 h', gapDays: '0', start: '', origin: 1, waitsFor: '' },
    ]);
    expect(withoutBlock({ ...draft, start: '2026-10-05T09:00' }, 0).start).toBe('2026-10-06T13:00');
    expect(withoutBlock({ ...draft, start: '2026-10-09T09:00' }, 0).start).toBe('2026-10-09T09:00');
    expect(withoutBlock({ ...draft, start: 'soon' }, 0).start).toBe('soon');
  });
});

describe('date constraints in the details panel', () => {
  const CONSTRAINED = workTask('c', {
    mustFinishOn: at(2026, 10, 9, 17),
    deadline: at(2026, 10, 12, 12) + 0.75,
  });

  it('fills both dates and builds the same task back', () => {
    const draft = draftFromTask(CONSTRAINED, NO_WAITS, '');
    expect([draft.mustFinishOn, draft.deadline]).toEqual(['2026-10-09T17:00', '2026-10-12T12:45']);
    expect(taskFromDraft(CONSTRAINED, draft, 9, ON)).toEqual({ ok: true, value: CONSTRAINED });
  });

  it('sets and clears the dates of a milestone', () => {
    const point = milestone('m');
    const set = { ...draftFromTask(point, NO_WAITS, ''), deadline: '2026-10-20T08:00' };
    expect(taskFromDraft(point, set, 9, ON)).toEqual({
      ok: true,
      value: { ...point, deadline: at(2026, 10, 20, 8) },
    });
    const cleared = {
      ...draftFromTask(CONSTRAINED, NO_WAITS, ''),
      mustFinishOn: ' ',
      deadline: '',
    };
    expect(taskFromDraft(CONSTRAINED, cleared, 9, ON)).toEqual({
      ok: true,
      value: { ...CONSTRAINED, mustFinishOn: null, deadline: null },
    });
  });

  it.each([
    ['the date it must finish on', { mustFinishOn: 'soon' }, 'INVALID_MUST_FINISH_ON'],
    ['the deadline', { deadline: '2026-13-40T12:00' }, 'INVALID_DEADLINE'],
    [
      'both dates, naming the first one',
      { mustFinishOn: 'soon', deadline: 'later' },
      'INVALID_MUST_FINISH_ON',
    ],
  ])('refuses %s when it cannot be read', (_label, change, error) => {
    const draft = { ...draftFromTask(CONSTRAINED, NO_WAITS, ''), ...change };
    expect(taskFromDraft(CONSTRAINED, draft, 9, ON)).toEqual({ ok: false, error });
  });

  it('keeps the dates of the task untouched while date constraints are turned off', () => {
    const draft = {
      ...draftFromTask(CONSTRAINED, NO_WAITS, ''),
      mustFinishOn: 'soon',
      deadline: '',
      name: 'Renamed',
    };
    expect(taskFromDraft(CONSTRAINED, draft, 9, OFF)).toEqual({
      ok: true,
      value: { ...CONSTRAINED, name: 'Renamed' },
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
    const constrained = { ...plan.options, dateConstraintsEnabled: true };
    expect(taskBasis({ ...plan, options: constrained }, 's')).not.toBe(basis);
    expect(
      taskBasis({ ...plan, options: { ...plan.options, criticalPathEnabled: true } }, 's'),
    ).toBe(basis);
  });
});
