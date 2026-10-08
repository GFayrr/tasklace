import { describe, expect, it } from 'vitest';
import { compileCalendar, type CompiledCalendar } from '../../src/core/calendar/compile-calendar';
import { readHeader } from '../../src/core/exchange/csv/csv-columns';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { importProjectCsv } from '../../src/core/exchange/csv/project-csv-import';
import type { RegionalFormat } from '../../src/core/exchange/csv/regional-format';
import { parsePredecessors } from '../../src/core/exchange/csv/task-notations';
import { exportProjectJson, importProjectJson } from '../../src/core/exchange/project-json';
import type { Project } from '../../src/core/model/project';
import { scheduleProject, type Schedule } from '../../src/core/scheduling/schedule-project';
import { placeTask } from '../../src/core/scheduling/task-placement';
import { detectTagConflicts } from '../../src/core/tags/tag-conflicts';
import { unwrap } from '../../src/core/testing/arbitraries';
import { at } from '../../src/core/testing/civil-time';
import { blockLink, project, splitTask, workTask } from '../../src/core/testing/project-builder';
import { readProject, STORED_VALUE_CODEC } from '../../src/core/validation/read-project';
import { endVarianceDays } from '../../src/core/baseline/end-variance';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  batched,
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SIZE_FACTOR,
  SMALL_TASK_COUNT,
} from './measure-growth';

const SHORT_TASK_HOURS = 2_000;
const VARIANCES_PER_RUN = 1_000;
const BLANK_LINES_PER_TASK = 40;
const CSV_FORMAT: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const PLACEMENTS_PER_RUN = 200;
const SHORT_TEXT_LENGTH = 1_000_000;
const CELLS_PER_RUN = 1_000;
const PREDECESSOR_LIMIT = 10;
const SPLIT_BLOCK_HOURS = 2;
const LAST_SPLIT_BLOCK = 2;

/** Schedules a project, failing the test when scheduling fails. */
function scheduleOf(input: Project): Schedule {
  const schedule = scheduleProject(input);
  if (!schedule.ok) {
    throw new Error(JSON.stringify(schedule.error));
  }
  return schedule.value;
}

/** Compiles the calendar of a project, failing the test when it is invalid. */
function calendarOf(input: Project): CompiledCalendar {
  const calendar = compileCalendar(input.calendar);
  if (!calendar.ok) {
    throw new Error(JSON.stringify(calendar.error));
  }
  return calendar.value;
}

describe('growth of whole-project operations (n tasks, 2n dependencies)', () => {
  const small = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const large = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  it('schedules in linear time', () => {
    const ratio = growthRatio(
      () => scheduleProject(small),
      () => scheduleProject(large),
    );
    console.info(`Schedule: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('validates a project in linear time', () => {
    const ratio = growthRatio(
      () => readProject(small, STORED_VALUE_CODEC),
      () => readProject(large, STORED_VALUE_CODEC),
    );
    console.info(`Validation: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('imports JSON in linear time', () => {
    const smallText = exportProjectJson(small);
    const largeText = exportProjectJson(large);
    const ratio = growthRatio(
      () => importProjectJson(smallText),
      () => importProjectJson(largeText),
    );
    console.info(`JSON import: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('imports CSV in linear time', () => {
    const smallText = unwrap(exportProjectCsv(small, scheduleOf(small), CSV_FORMAT));
    const largeText = unwrap(exportProjectCsv(large, scheduleOf(large), CSV_FORMAT));
    const options = { format: CSV_FORMAT, projectName: 'Growth', fallbackStart: small.startDate };
    expect(importProjectCsv(smallText, options).ok).toBe(true);
    expect(importProjectCsv(largeText, options).ok).toBe(true);
    const ratio = growthRatio(
      () => importProjectCsv(smallText, options),
      () => importProjectCsv(largeText, options),
    );
    console.info(`CSV import: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('skips blank CSV lines in linear time', () => {
    /** Builds a CSV table holding one task after a number of separator-only lines. */
    const blankLines = (count: number) => `Name;Duration${'\n;'.repeat(count)}\nA;7`;
    const smallText = blankLines(SMALL_TASK_COUNT * BLANK_LINES_PER_TASK);
    const largeText = blankLines(LARGE_TASK_COUNT * BLANK_LINES_PER_TASK);
    const options = { format: CSV_FORMAT, projectName: 'Growth', fallbackStart: small.startDate };
    expect(importProjectCsv(largeText, options).ok).toBe(true);
    const ratio = growthRatio(
      () => importProjectCsv(smallText, options),
      () => importProjectCsv(largeText, options),
    );
    console.info(`CSV blank lines: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('exports CSV in quasi-linear time', () => {
    const smallSchedule = scheduleOf(small);
    const largeSchedule = scheduleOf(large);
    const ratio = growthRatio(
      () => unwrap(exportProjectCsv(small, smallSchedule, CSV_FORMAT)),
      () => unwrap(exportProjectCsv(large, largeSchedule, CSV_FORMAT)),
    );
    console.info(`CSV export: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('detects person conflicts in quasi-linear time', () => {
    const smallSchedule = scheduleOf(small);
    const largeSchedule = scheduleOf(large);
    const calendar = calendarOf(small);
    const ratio = growthRatio(
      () => detectTagConflicts(small.tasks, small.tags, smallSchedule.placements, calendar),
      () => detectTagConflicts(large.tasks, large.tags, largeSchedule.placements, calendar),
    );
    console.info(`Person conflicts: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});

/** Builds a project of split tasks in pairs, the second task of each pair running between the first and last blocks of the first one, as block links allow. */
function interleavedProject(taskCount: number): Project {
  const ids = Array.from({ length: taskCount }, (_unused, index) => `s${String(index)}`);
  const tasks = ids.map((id) =>
    splitTask(id, [
      [SPLIT_BLOCK_HOURS, 0],
      [SPLIT_BLOCK_HOURS, 0],
      [SPLIT_BLOCK_HOURS, 0],
    ]),
  );
  const links = ids.flatMap((id, index) => {
    const inside = ids[index + 1];
    if (index % 2 !== 0 || inside === undefined) {
      return [];
    }
    return [blockLink(id, inside, { from: 0 }), blockLink(inside, id, { to: LAST_SPLIT_BLOCK })];
  });
  return project(tasks, links, {
    options: {
      criticalPathEnabled: true,
      dateConstraintsEnabled: false,
      baselineEnabled: false,
      alwaysShowPatterns: false,
    },
  });
}

describe('growth of scheduling split tasks linked block by block', () => {
  it('schedules with the critical path in linear time', () => {
    const small = interleavedProject(SMALL_TASK_COUNT);
    const large = interleavedProject(LARGE_TASK_COUNT);
    expect(scheduleProject(large).ok).toBe(true);
    const ratio = growthRatio(
      () => scheduleProject(small),
      () => scheduleProject(large),
    );
    console.info(`Schedule split tasks linked by blocks: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});

describe('growth of task placement with the duration of the task', () => {
  it('places a task in a time that does not depend on its duration', () => {
    const calendar = calendarOf(project([]));
    const start = at(2026, 9, 28, 9);
    const shortTask = workTask('short', {
      segments: [{ durationHours: SHORT_TASK_HOURS, gapDaysBefore: 0, startNoEarlierThan: null }],
      hoursPerDay: 3,
    });
    const longTask = workTask('long', {
      segments: [
        {
          durationHours: SHORT_TASK_HOURS * SIZE_FACTOR,
          gapDaysBefore: 0,
          startNoEarlierThan: null,
        },
      ],
      hoursPerDay: 3,
    });
    const ratio = growthRatio(
      batched(PLACEMENTS_PER_RUN, () => placeTask(calendar, shortTask, start)),
      batched(PLACEMENTS_PER_RUN, () => placeTask(calendar, longTask, start)),
    );
    console.info(`Task placement: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});

describe('growth of the variance with the baseline', () => {
  it('counts the working days between two ends in a time that does not depend on the gap', () => {
    const calendar = calendarOf(project([]));
    const frozen = at(2026, 9, 28, 17);
    const shortGap = frozen + SHORT_TASK_HOURS;
    const longGap = frozen + SHORT_TASK_HOURS * SIZE_FACTOR;
    const ratio = growthRatio(
      batched(VARIANCES_PER_RUN, () => endVarianceDays(calendar, frozen, shortGap)),
      batched(VARIANCES_PER_RUN, () => endVarianceDays(calendar, frozen, longGap)),
    );
    console.info(`End variance: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});

describe('growth of reading forged CSV cells', () => {
  it('leaves a huge header unread in a time that does not depend on its length', () => {
    /** Writes a header of a given length that no column can match. */
    const header = (length: number) => '('.repeat(length);
    const short = header(SHORT_TEXT_LENGTH);
    const long = header(SHORT_TEXT_LENGTH * SIZE_FACTOR);
    const ratio = growthRatio(
      batched(CELLS_PER_RUN, () => readHeader(short)),
      batched(CELLS_PER_RUN, () => readHeader(long)),
    );
    console.info(`Huge header: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });

  it('refuses a huge list of predecessors in a time that does not depend on its length, counting only up to the limit', () => {
    /** Writes a list of predecessors of a given length. */
    const list = (length: number) => '1,'.repeat(length);
    const short = list(SHORT_TEXT_LENGTH);
    const long = list(SHORT_TEXT_LENGTH * SIZE_FACTOR);
    const ratio = growthRatio(
      batched(CELLS_PER_RUN, () => parsePredecessors(short, PREDECESSOR_LIMIT)),
      batched(CELLS_PER_RUN, () => parsePredecessors(long, PREDECESSOR_LIMIT)),
    );
    console.info(`Huge list of predecessors: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});
