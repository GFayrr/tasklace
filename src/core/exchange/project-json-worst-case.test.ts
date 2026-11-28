import { describe, expect, it } from 'vitest';
import {
  MAX_DEPENDENCIES,
  MAX_IDENTIFIER_LENGTH,
  MAX_LAG_HOURS,
  MAX_NON_WORKING_PERIODS,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_TEXT_UTF16_UNITS,
  MAX_SEGMENTS_PER_TASK,
  MAX_SORT_KEY_LENGTH,
  MAX_TAGS,
  MAX_TAG_NAME_LENGTH,
  MAX_TASK_DURATION_HOURS,
  MAX_TASK_NAME_LENGTH,
  MAX_TASKS,
  MAX_WORKING_TIME_RANGES,
} from '../limits';
import type { BaselineEntry, Dependency, Project, Tag, WorkTask } from '../model/project';
import { at, dayOf } from '../testing/civil-time';
import { project, testId } from '../testing/project-builder';
import { WEEKDAYS } from '../time';
import { exportProjectJson } from './project-json';

const ESCAPED_CHARACTER = '"';
const INDEX_DIGITS = 4;
const QUARTERS_BEFORE_MIDNIGHT = 0.75;
const LATE = at(2200, 12, 31, 23) + QUARTERS_BEFORE_MIDNIGHT;
const LONGEST_LAG = -MAX_LAG_HOURS + 0.25;
const LONGEST_DAILY_HOUR = 23.75;
const LATE_GAP_DAYS = 3_650;
const LARGEST_EXPORT = 335_659_902;

/** Gives an identifier of the longest allowed length, unique by its index. */
function longestId(prefix: string, index: number): string {
  const digits = String(index).padStart(INDEX_DIGITS, '0');
  return `${prefix.repeat(MAX_IDENTIFIER_LENGTH - INDEX_DIGITS)}${digits}`;
}

/** Builds a work task whose every field takes the most room in JSON: the longest texts, all made of characters JSON escapes, and every block with a start date. */
function largestTask(index: number): WorkTask {
  const blockHours = MAX_TASK_DURATION_HOURS / MAX_SEGMENTS_PER_TASK - 0.25;
  const [first, ...later] = Array.from({ length: MAX_SEGMENTS_PER_TASK }, (_, block) => ({
    durationHours: blockHours,
    gapDaysBefore: block === 0 ? 0 : LATE_GAP_DAYS,
    startNoEarlierThan: block === 0 ? null : LATE,
  }));
  if (first === undefined) {
    throw new Error('A task needs a block.');
  }
  return {
    kind: 'task',
    id: testId(longestId('t', index)),
    name: ESCAPED_CHARACTER.repeat(MAX_TASK_NAME_LENGTH),
    parentId: testId(longestId('p', index)),
    sortKey: 'k'.repeat(MAX_SORT_KEY_LENGTH),
    segments: [first, ...later],
    hoursPerDay: LONGEST_DAILY_HOUR,
    dailyStartHour: LONGEST_DAILY_HOUR,
    progressPercent: 100,
    tagId: testId(longestId('g', index)),
    startNoEarlierThan: LATE,
    mustFinishOn: LATE,
    deadline: LATE,
  };
}

/** Builds a dependency of the longest identifiers, a lead of the longest number and blocks at both ends. */
function largestDependency(index: number): Dependency {
  return {
    id: testId(longestId('d', index)),
    predecessorId: testId(longestId('t', index)),
    successorId: testId(longestId('s', index)),
    type: 'finishToFinish',
    lagHours: LONGEST_LAG,
    predecessorBlock: MAX_SEGMENTS_PER_TASK - 1,
    successorBlock: MAX_SEGMENTS_PER_TASK - 1,
  };
}

/** Builds a tag of the longest identifier and name. */
function largestTag(index: number): Tag {
  return {
    id: testId(longestId('g', index)),
    name: ESCAPED_CHARACTER.repeat(MAX_TAG_NAME_LENGTH),
    color: '#aaaaaa',
    representsPersonOrTeam: false,
  };
}

/** Builds a baseline entry of the longest identifier and dates. */
function largestEntry(index: number): BaselineEntry {
  return {
    taskId: testId(longestId('t', index)),
    start: LATE,
    end: LATE,
    durationHours: MAX_TASK_DURATION_HOURS,
  };
}

/** Builds a project holding a given number of each of the largest items, with the fullest calendar. */
function projectOf(count: number): Project {
  /** Lists a number of items built from their index. */
  const many = <T>(build: (index: number) => T): T[] =>
    Array.from({ length: count }, (_, index) => build(index));
  return project(many(largestTask), many(largestDependency), {
    name: ESCAPED_CHARACTER.repeat(MAX_PROJECT_NAME_LENGTH),
    calendar: {
      workingWeekdays: [...WEEKDAYS],
      workingTimeRanges: Array.from({ length: MAX_WORKING_TIME_RANGES }, () => ({
        startHour: 23.75,
        endHour: 23.75,
      })),
      nonWorkingPeriods: Array.from({ length: MAX_NON_WORKING_PERIODS }, () => ({
        firstDay: dayOf(2200, 12, 31),
        lastDay: dayOf(2200, 12, 31),
      })),
    },
    tags: many(largestTag),
    baseline: { takenAt: LATE, entries: many(largestEntry) },
  });
}

describe('the largest JSON export', () => {
  it('stays within the import limit, every block writing its start date, at every limit of the lists at once', () => {
    const one = exportProjectJson(projectOf(1)).length;
    const two = exportProjectJson(projectOf(2)).length;
    const perItemRow = two - one;
    const withoutItems = one - perItemRow;
    const tagsLeftOut = (MAX_TASKS - MAX_TAGS) * exportedLength(largestTag(0));
    const dependenciesAdded =
      (MAX_DEPENDENCIES - MAX_TASKS) * (exportedLength(largestDependency(0)) + 1);
    const largest = withoutItems + MAX_TASKS * perItemRow - tagsLeftOut + dependenciesAdded;
    expect([largest, largest < MAX_PROJECT_TEXT_UTF16_UNITS]).toEqual([LARGEST_EXPORT, true]);
  });
});

/** Gives the length of an item written as JSON text. */
function exportedLength(item: unknown): number {
  return JSON.stringify(item).length;
}
