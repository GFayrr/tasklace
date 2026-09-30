import { describe, expect, it } from 'vitest';
import type { RegionalFormat } from '../../core/exchange/csv/regional-format';
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

const ISO: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'yearMonthDay',
  dateSeparator: '-',
  twelveHourClock: false,
};
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
const SOURCE: CellSource = {
  schedule: scheduleOrThrow(PLAN),
  calendar: compileOrThrow(TEST_CALENDAR),
  incoming: groupIncoming(PLAN.dependencies),
  wbsById: OUTLINE.wbsById,
  format: ISO,
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
    for (const column of ['name', 'duration', 'progress', 'predecessors'] as const) {
      const edit = cellEdit(context, 'm', column, editorText(taskOf('m'), column, SOURCE), SOURCE);
      expect(edit.ok).toBe(true);
    }
    for (const column of ['start', 'end', 'duration'] as const) {
      const edit = cellEdit(context, 'b', column, editorText(taskOf('b'), column, SOURCE), SOURCE);
      expect(edit.ok && edit.value).toEqual([{ type: 'putTask', task: taskOf('b') }]);
    }
    const noSchedule = { ...SOURCE, schedule: null };
    expect(cellEdit(context, 'b', 'end', 'x', noSchedule)).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
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
    expect(nextColumn('predecessors', 1)).toBe('predecessors');
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
