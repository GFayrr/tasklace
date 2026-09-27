import { describe, expect, it } from 'vitest';
import { compileOrThrow, at } from '../testing/civil-time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../testing/project-builder';
import { DEFAULT_CALENDAR } from '../calendar/default-calendar';
import { END_PROJECT_HOUR } from '../time';
import { takeBaseline } from './take-baseline';

const TAKEN_AT = at(2026, 9, 27, 18);

describe('takeBaseline', () => {
  it('freezes the start, end and duration of tasks, milestones and summaries', () => {
    const input = project(
      [
        summary('phase'),
        workTask('a', { parentId: 'phase' }),
        splitTask(
          'b',
          [
            [3, 0],
            [4, 2],
          ],
          { parentId: 'phase' },
        ),
        milestone('m'),
      ],
      [link('a', 'b'), link('b', 'm')],
    );
    const schedule = scheduleOrThrow(input);
    const taken = takeBaseline(input, schedule, compileOrThrow(DEFAULT_CALENDAR), TAKEN_AT);
    const placementOf = (id: string) => schedule.placements.get(id);
    expect(taken.skippedTaskIds).toEqual([]);
    expect(taken.baseline.takenAt).toBe(TAKEN_AT);
    expect(taken.baseline.entries).toEqual([
      { taskId: 'phase', start: at(2026, 9, 28, 9), end: placementOf('b')?.end, durationHours: 25 },
      { taskId: 'a', start: at(2026, 9, 28, 9), end: placementOf('a')?.end, durationHours: 7 },
      { taskId: 'b', start: placementOf('b')?.start, end: placementOf('b')?.end, durationHours: 7 },
      { taskId: 'm', start: placementOf('m')?.start, end: placementOf('m')?.end, durationHours: 0 },
    ]);
  });

  it('skips an empty summary, which has no dates', () => {
    const input = project([summary('empty'), workTask('a')]);
    const taken = takeBaseline(
      input,
      scheduleOrThrow(input),
      compileOrThrow(DEFAULT_CALENDAR),
      TAKEN_AT,
    );
    expect(taken.skippedTaskIds).toEqual(['empty']);
    expect(taken.baseline.entries.map((entry) => entry.taskId)).toEqual(['a']);
  });

  it('skips a task whose end falls outside the supported period', () => {
    const input = project([workTask('a')]);
    const placements = new Map([
      ['a', { start: END_PROJECT_HOUR - 1, end: END_PROJECT_HOUR, segments: [] }],
    ]);
    const taken = takeBaseline(
      input,
      { placements, summaries: new Map() },
      compileOrThrow(DEFAULT_CALENDAR),
      TAKEN_AT,
    );
    expect(taken).toEqual({ baseline: { takenAt: TAKEN_AT, entries: [] }, skippedTaskIds: ['a'] });
  });
});
