import { describe, expect, it } from 'vitest';
import { at } from '../../core/testing/civil-time';
import { summary, workTask } from '../../core/testing/project-builder';
import { entriesByTask, unfrozenTasks } from './baseline-view';

describe('entriesByTask', () => {
  it('gives the frozen dates of each task by its identifier', () => {
    const a = {
      taskId: 'a',
      start: at(2026, 10, 1, 9),
      end: at(2026, 10, 1, 17),
      durationHours: 7,
    };
    const b = {
      taskId: 'b',
      start: at(2026, 10, 2, 9),
      end: at(2026, 10, 2, 17),
      durationHours: 7,
    };
    const baseline = { takenAt: at(2026, 9, 30, 9), entries: [a, b] };
    const entries = entriesByTask(baseline);
    expect([...entries]).toEqual([
      ['a', a],
      ['b', b],
    ]);
    expect(entriesByTask(baseline)).toBe(entries);
    expect(entriesByTask({ ...baseline })).not.toBe(entries);
  });
});

describe('unfrozenTasks', () => {
  it('lists the tasks that could not be frozen, except the empty summaries', () => {
    const tasks = [summary('empty'), workTask('a'), workTask('b')];
    expect(
      unfrozenTasks(
        [
          { taskId: 'empty', reason: 'NO_DATES' },
          { taskId: 'a', reason: 'NO_DATES' },
          { taskId: 'b', reason: 'OUT_OF_PERIOD' },
        ],
        tasks,
      ),
    ).toEqual([
      { taskId: 'a', reason: 'NO_DATES' },
      { taskId: 'b', reason: 'OUT_OF_PERIOD' },
    ]);
    expect(unfrozenTasks([{ taskId: 'empty', reason: 'OUT_OF_PERIOD' }], tasks)).toEqual([
      { taskId: 'empty', reason: 'OUT_OF_PERIOD' },
    ]);
    expect(unfrozenTasks([], tasks)).toEqual([]);
  });
});
