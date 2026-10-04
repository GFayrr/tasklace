import { describe, expect, it } from 'vitest';
import english from '../locales/en.json';
import { scheduleFailureText } from './schedule-failure-text';

const NAMES = new Map([['a', 'Write report']]);

/** Finds the name of a task of the sample, or none. */
function nameOf(id: string): string | null {
  return NAMES.get(id) ?? null;
}

describe('scheduleFailureText', () => {
  it('explains an invalid calendar with each of its problems', () => {
    expect(
      scheduleFailureText(
        english,
        {
          kind: 'calendar',
          errors: [
            { code: 'NO_WORKING_WEEKDAY' },
            { code: 'INVALID_WORKING_TIME_RANGE', index: 1 },
          ],
        },
        nameOf,
      ),
    ).toEqual({
      text: english.scheduleFailures.calendar,
      entries: [english.issues.NO_WORKING_WEEKDAY, english.issues.INVALID_WORKING_TIME_RANGE],
    });
  });

  it('explains a start date outside the supported years without details', () => {
    expect(scheduleFailureText(english, { kind: 'startDate' }, nameOf)).toEqual({
      text: english.scheduleFailures.startDate,
      entries: [],
    });
  });

  it('places each problem of the plan on its task, by name or position, its link or its tag', () => {
    expect(
      scheduleFailureText(
        english,
        {
          kind: 'structure',
          errors: [
            { code: 'HIERARCHY_CYCLE', list: 'tasks', index: 0, taskId: 'a' },
            { code: 'DUPLICATE_TASK_ID', list: 'tasks', index: 3, taskId: 'gone' },
            { code: 'SELF_DEPENDENCY', list: 'dependencies', index: 1, dependencyId: 'a-a' },
            { code: 'DUPLICATE_TAG_ID', list: 'tags', index: 2, tagId: 't' },
            { code: 'TOO_MANY_TASKS' },
          ],
        },
        nameOf,
      ),
    ).toEqual({
      text: english.scheduleFailures.structure,
      entries: [
        `Task “Write report”: ${english.issues.HIERARCHY_CYCLE}`,
        `Task 4: ${english.issues.DUPLICATE_TASK_ID}`,
        `Link 2: ${english.issues.SELF_DEPENDENCY}`,
        `Tag 3: ${english.issues.DUPLICATE_TAG_ID}`,
        english.issues.TOO_MANY_TASKS,
      ],
    });
  });

  it('names the task that cannot be placed, by its identifier when it has no name, and says why', () => {
    const failure = {
      kind: 'task',
      error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'a' },
    } as const;
    expect(scheduleFailureText(english, failure, nameOf)).toEqual({
      text: english.scheduleFailures.task.replace('{name}', 'Write report'),
      entries: [english.issues.BEYOND_PLANNING_HORIZON],
    });
    expect(scheduleFailureText(english, failure, () => null).text).toBe(
      english.scheduleFailures.task.replace('{name}', 'a'),
    );
  });
});
