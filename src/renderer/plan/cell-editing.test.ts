import { describe, expect, it } from 'vitest';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import { TEST_CALENDAR } from '../../core/testing/test-calendar';
import { buildPlanOutline, groupIncoming } from './plan-outline';
import {
  cellEdit,
  editorText,
  hourFromPicker,
  isEditable,
  nextColumn,
  pickerValue,
  type CellSource,
} from './cell-editing';

const PLAN = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's', progressPercent: 30 }),
    splitTask(
      'b',
      [
        [7, 0],
        [5, 1],
      ],
      { startNoEarlierThan: at(2026, 10, 5, 9) },
    ),
    milestone('m'),
  ],
  [link('a', 'b'), link('b', 'm', 'startToStart', 3)],
);
const OUTLINE = buildPlanOutline(PLAN.tasks, new Set());
const SCHEDULE = scheduleOrThrow(PLAN);
const SOURCE: CellSource = {
  schedule: SCHEDULE,
  current: { ok: true, value: SCHEDULE },
  calendar: compileOrThrow(TEST_CALENDAR),
  incoming: groupIncoming(PLAN.dependencies),
  wbsById: OUTLINE.wbsById,
};

/** Finds a task of the sample plan. */
function taskOf(id: string) {
  const task = PLAN.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(id);
  }
  return task;
}

describe('editorText', () => {
  it('starts each editor with text that reads back to the same value', () => {
    expect(editorText(taskOf('b'), 'duration', SOURCE)).toBe('12 h');
    expect(editorText(taskOf('b'), 'end', SOURCE)).toBe('2026-10-06 15:00');
    expect(editorText(taskOf('b'), 'start', SOURCE)).toBe('2026-10-05 09:00');
    expect(editorText(taskOf('a'), 'start', SOURCE)).toBe('2026-09-28 09:00');
    expect(editorText(taskOf('a'), 'progress', SOURCE)).toBe('30');
    expect(editorText(taskOf('m'), 'predecessors', SOURCE)).toBe('2SS+3h');
    expect(editorText(taskOf('m'), 'duration', SOURCE)).toBe('0 h');
    expect(editorText(taskOf('s'), 'duration', SOURCE)).toBe('s');
  });

  it('builds the change that the same text asks for, without any difference', () => {
    const context = { project: PLAN, outline: OUTLINE, createId: () => 'new', dayHours: 7 };
    const unchanged = [{ type: 'putTask', task: taskOf('m') }];
    for (const [column, expected] of [
      ['name', unchanged],
      ['duration', []],
      ['progress', unchanged],
      ['predecessors', []],
    ] as const) {
      const edit = cellEdit(context, 'm', column, editorText(taskOf('m'), column, SOURCE), SOURCE);
      expect(edit).toEqual({ ok: true, value: expected });
    }
    for (const column of ['start', 'end', 'duration'] as const) {
      const edit = cellEdit(context, 'b', column, editorText(taskOf('b'), column, SOURCE), SOURCE);
      expect(edit.ok && edit.value).toEqual([{ type: 'putTask', task: taskOf('b') }]);
    }
    const noSchedule = { ...SOURCE, schedule: null, current: { ok: true, value: null } } as const;
    expect(cellEdit(context, 'b', 'end', 'x', noSchedule)).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('refuses a typed start or end while the schedule shown is older than the latest change, telling why', () => {
    const context = { project: PLAN, outline: OUTLINE, createId: () => 'new', dayHours: 7 };
    for (const error of ['SCHEDULE_PENDING', 'SCHEDULE_STOPPED'] as const) {
      const waiting: CellSource = { ...SOURCE, current: { ok: false, error } };
      for (const column of ['start', 'end'] as const) {
        expect(cellEdit(context, 'b', column, '2026-10-01 10:00', waiting)).toEqual({
          ok: false,
          error,
        });
      }
      expect(cellEdit(context, 'b', 'name', 'Renamed', waiting).ok).toBe(true);
    }
  });
});

describe('tags and dates in cells', () => {
  const tagged = project([workTask('t', { tagId: 'design' }), workTask('u')], [], {
    tags: [{ id: 'design', name: 'Design', color: '#3366AA', representsPersonOrTeam: false }],
  });
  const source: CellSource = {
    ...SOURCE,
    schedule: null,
    current: { ok: true, value: null },
    incoming: new Map(),
    wbsById: new Map(),
  };
  const context = {
    project: tagged,
    outline: buildPlanOutline(tagged.tasks, new Set()),
    createId: () => 'new',
    dayHours: 7,
  };

  it('starts the tag editor with the tag of the task, or empty without one', () => {
    const [first, second] = tagged.tasks;
    if (first === undefined || second === undefined) {
      throw new Error('Missing task');
    }
    expect(editorText(first, 'tag', source)).toBe('design');
    expect(editorText(second, 'tag', source)).toBe('');
  });

  it('leaves the dates of a task empty until the schedule is known', () => {
    const [, second] = tagged.tasks;
    if (second === undefined) {
      throw new Error('Missing task');
    }
    expect(editorText(second, 'start', source)).toBe('');
    expect(editorText(second, 'end', source)).toBe('');
  });

  it('sets a tag, or removes it with an empty choice', () => {
    expect(cellEdit(context, 'u', 'tag', 'design', source)).toMatchObject({
      ok: true,
      value: [{ type: 'putTask', task: { id: 'u', tagId: 'design' } }],
    });
    expect(cellEdit(context, 't', 'tag', '', source)).toMatchObject({
      ok: true,
      value: [{ type: 'putTask', task: { id: 't', tagId: null } }],
    });
  });

  it('sets a typed start without a schedule, its later blocks keeping their dates', () => {
    expect(cellEdit(context, 'u', 'start', '2026-10-01 10:00', source)).toMatchObject({
      ok: true,
      value: [{ type: 'putTask', task: { id: 'u', startNoEarlierThan: at(2026, 10, 1, 10) } }],
    });
  });
});

describe('editable columns', () => {
  it('lets only the name of a summary be edited', () => {
    expect(isEditable(taskOf('s'), 'name')).toBe(true);
    expect(isEditable(taskOf('s'), 'duration')).toBe(false);
    expect(isEditable(taskOf('m'), 'start')).toBe(true);
  });

  it('moves between editable columns, staying at the edges', () => {
    expect(nextColumn('name', 1)).toBe('duration');
    expect(nextColumn('name', -1)).toBe('name');
    expect(nextColumn('predecessors', 1)).toBe('tag');
    expect(nextColumn('tag', 1)).toBe('tag');
    expect(nextColumn('progress', -1)).toBe('end');
  });
});

describe('date and time picker values', () => {
  it('writes an instant as a picker value and reads it back', () => {
    const hour = at(2026, 10, 5, 14) + 0.75;
    expect(pickerValue(hour)).toBe('2026-10-05T14:45');
    expect(hourFromPicker(pickerValue(hour))).toBe(hour);
  });

  it('rounds a picked time to the nearest quarter hour, even past the hour', () => {
    expect(hourFromPicker('2026-10-05T14:07')).toBe(at(2026, 10, 5, 14));
    expect(hourFromPicker('2026-10-05T14:08')).toBe(at(2026, 10, 5, 14) + 0.25);
    expect(hourFromPicker('2026-10-05T14:53:10')).toBe(at(2026, 10, 5, 15));
  });

  it('refuses an empty or impossible value', () => {
    expect(hourFromPicker('')).toBeNull();
    expect(hourFromPicker('2026-02-31T10:00')).toBeNull();
    expect(hourFromPicker('tomorrow')).toBeNull();
  });
});

describe('typing the start of a split task', () => {
  it('moves the dates of its later blocks by as much as the task', () => {
    const dated = project([
      splitTask('d', [
        [7, 0],
        [7, 1, at(2026, 10, 5, 13)],
      ]),
    ]);
    const schedule = scheduleOrThrow(dated);
    const context = {
      project: dated,
      outline: buildPlanOutline(dated.tasks, new Set()),
      createId: () => 'new',
      dayHours: 7,
    };
    const source: CellSource = { ...SOURCE, schedule, current: { ok: true, value: schedule } };
    const edit = cellEdit(context, 'd', 'start', '2026-09-30 09:00', source);
    const operation = edit.ok
      ? edit.value.find((candidate) => candidate.type === 'putTask')
      : undefined;
    expect(operation?.type === 'putTask' && operation.task).toMatchObject({
      segments: [{ startNoEarlierThan: null }, { startNoEarlierThan: at(2026, 10, 7, 13) }],
    });
  });
});
