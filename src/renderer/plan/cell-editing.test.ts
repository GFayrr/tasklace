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
import { at } from '../../core/testing/civil-time';
import { buildPlanOutline, groupIncoming } from './plan-outline';
import { cellEdit, editorText, isEditable, nextColumn, type CellSource } from './cell-editing';

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
    expect(editorText(taskOf('b'), 'duration', SOURCE)).toBe('12');
    expect(editorText(taskOf('b'), 'start', SOURCE)).toBe('2026-10-05 09:00');
    expect(editorText(taskOf('a'), 'start', SOURCE)).toBe('2026-09-28 09:00');
    expect(editorText(taskOf('a'), 'progress', SOURCE)).toBe('30');
    expect(editorText(taskOf('m'), 'predecessors', SOURCE)).toBe('2SS+3h');
    expect(editorText(taskOf('m'), 'duration', SOURCE)).toBe('0');
    expect(editorText(taskOf('s'), 'duration', SOURCE)).toBe('s');
  });

  it('builds the change that the same text asks for, without any difference', () => {
    const context = { project: PLAN, outline: OUTLINE, createId: () => 'new', dayHours: 7 };
    for (const column of ['name', 'duration', 'progress', 'predecessors'] as const) {
      const edit = cellEdit(context, 'm', column, editorText(taskOf('m'), column, SOURCE), ISO);
      expect(edit.ok).toBe(true);
    }
    const start = cellEdit(context, 'b', 'start', editorText(taskOf('b'), 'start', SOURCE), ISO);
    expect(start.ok && start.value).toEqual([{ type: 'putTask', task: taskOf('b') }]);
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
    expect(nextColumn('progress', -1)).toBe('start');
  });
});
