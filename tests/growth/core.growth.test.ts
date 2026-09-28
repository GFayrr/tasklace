import { describe, expect, it } from 'vitest';
import { compileCalendar, type CompiledCalendar } from '../../src/core/calendar/compile-calendar';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { importProjectCsv } from '../../src/core/exchange/csv/project-csv-import';
import type { RegionalFormat } from '../../src/core/exchange/csv/regional-format';
import { exportProjectJson, importProjectJson } from '../../src/core/exchange/project-json';
import type { Project } from '../../src/core/model/project';
import { scheduleProject, type Schedule } from '../../src/core/scheduling/schedule-project';
import { placeTask } from '../../src/core/scheduling/task-placement';
import { detectTagConflicts } from '../../src/core/tags/tag-conflicts';
import { unwrap } from '../../src/core/testing/arbitraries';
import { at } from '../../src/core/testing/civil-time';
import { project, workTask } from '../../src/core/testing/project-builder';
import { readProject, STORED_VALUE_CODEC } from '../../src/core/validation/read-project';
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
const CSV_FORMAT: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const PLACEMENTS_PER_RUN = 200;

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

describe('growth of task placement with the duration of the task', () => {
  it('places a task in a time that does not depend on its duration', () => {
    const calendar = calendarOf(project([]));
    const start = at(2026, 9, 28, 9);
    const shortTask = workTask('short', {
      segments: [{ durationHours: SHORT_TASK_HOURS, gapDaysBefore: 0 }],
      hoursPerDay: 3,
    });
    const longTask = workTask('long', {
      segments: [{ durationHours: SHORT_TASK_HOURS * SIZE_FACTOR, gapDaysBefore: 0 }],
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
