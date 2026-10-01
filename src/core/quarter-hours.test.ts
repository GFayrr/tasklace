import { describe, expect, it } from 'vitest';
import { computeTaskSlots } from './calendar/task-slots';
import { addWorkingHours, countWorkingHours, nextWorkingHour } from './calendar/working-time';
import { formatDateTime, parseDateTime } from './civil-format';
import { exportProjectCsv } from './exchange/csv/project-csv-export';
import { importProjectCsv } from './exchange/csv/project-csv-import';
import type { RegionalFormat } from './exchange/csv/regional-format';
import { parseCsvDate } from './exchange/csv/regional-format';
import { formatBlocks, parseBlocks, parsePredecessors } from './exchange/csv/task-notations';
import { exportProjectJson, importProjectJson } from './exchange/project-json';
import { unwrap } from './testing/arbitraries';
import { at, compileOrThrow } from './testing/civil-time';
import { link, project, scheduleOrThrow, splitTask, workTask } from './testing/project-builder';
import { TEST_CALENDAR } from './testing/test-calendar';
import { fromProjectHour, isProjectHour, toProjectHour } from './time';

const CALENDAR = compileOrThrow(TEST_CALENDAR);
const FRENCH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const AMERICAN: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'monthDayYear',
  dateSeparator: '/',
  twelveHourClock: true,
};

describe('quarter hours in dates', () => {
  it('converts wall-clock times to the quarter hour, and refuses other minutes', () => {
    expect(unwrap(toProjectHour({ year: 2026, month: 10, day: 5, hour: 9, minute: 45 }))).toBe(
      at(2026, 10, 5, 9) + 0.75,
    );
    expect(toProjectHour({ year: 2026, month: 10, day: 5, hour: 9, minute: 10 }).ok).toBe(false);
    expect(fromProjectHour(at(2026, 10, 5, 13) + 0.25)).toEqual({
      year: 2026,
      month: 10,
      day: 5,
      hour: 13,
      minute: 15,
    });
    expect(isProjectHour(at(2026, 10, 5) + 0.5)).toBe(true);
    expect(isProjectHour(at(2026, 10, 5) + 0.1)).toBe(false);
  });

  it('writes and reads minutes in JSON and CSV dates', () => {
    const hour = at(2026, 10, 5, 14) + 0.5;
    expect(formatDateTime(hour)).toBe('2026-10-05T14:30');
    expect(parseDateTime('2026-10-05T14:30')).toEqual({ ok: true, value: hour });
    expect(parseDateTime('2026-10-05T14:20').ok).toBe(false);
    expect(parseCsvDate('05/10/2026 14:30', FRENCH)).toEqual({
      ok: true,
      value: { kind: 'dateTime', hour },
    });
    expect(parseCsvDate('10/5/2026 2:30 PM', AMERICAN)).toEqual({
      ok: true,
      value: { kind: 'dateTime', hour },
    });
  });
});

describe('quarter hours in working time', () => {
  it('adds and counts quarter hours across a break', () => {
    const late = at(2026, 9, 28, 11) + 0.75;
    expect(unwrap(addWorkingHours(CALENDAR, late, 0.5))).toBe(at(2026, 9, 28, 13) + 0.25);
    expect(
      unwrap(countWorkingHours(CALENDAR, at(2026, 9, 28, 9) + 0.25, at(2026, 9, 28, 10))),
    ).toBe(0.75);
    expect(unwrap(nextWorkingHour(CALENDAR, at(2026, 9, 28, 12) + 0.5))).toBe(at(2026, 9, 28, 13));
  });

  it('places a task of an hour and a half starting at half past eleven around the break', () => {
    const slots = unwrap(
      computeTaskSlots(CALENDAR, {
        start: at(2026, 9, 28, 11) + 0.5,
        durationHours: 1.5,
        hoursPerDay: null,
        dailyStartHour: null,
      }),
    );
    expect(slots).toEqual([
      { start: at(2026, 9, 28, 11) + 0.5, end: at(2026, 9, 28, 12) },
      { start: at(2026, 9, 28, 13), end: at(2026, 9, 28, 14) },
    ]);
  });
});

describe('quarter hours in schedules and exchanges', () => {
  const plan = project(
    [
      workTask('a', { segments: [{ durationHours: 0.25, gapDaysBefore: 0 }] }),
      splitTask('b', [
        [1.5, 0],
        [0.75, 1],
      ]),
    ],
    [link('a', 'b', 'finishToStart', 0.5)],
  );

  it('schedules a quarter-hour task and a half-hour lag', () => {
    const schedule = scheduleOrThrow(plan);
    expect(schedule.placements.get('a')).toMatchObject({
      start: at(2026, 9, 28, 9),
      end: at(2026, 9, 28, 9) + 0.25,
    });
    expect(schedule.placements.get('b')?.start).toBe(at(2026, 9, 28, 9) + 0.75);
  });

  it('keeps quarter hours through JSON', () => {
    expect(importProjectJson(exportProjectJson(plan))).toEqual({ ok: true, value: plan });
  });

  it('writes durations with the regional decimal mark, and reads both marks back', () => {
    const french = unwrap(exportProjectCsv(plan, scheduleOrThrow(plan), FRENCH));
    expect(french).toContain(';0,25;');
    expect(french).toContain('"1.5h; +1d 0.75h"');
    expect(french).toContain('1FS+0.5h');
    const american = unwrap(exportProjectCsv(plan, scheduleOrThrow(plan), AMERICAN));
    expect(american).toContain(',0.25,');
    const imported = unwrap(
      importProjectCsv('Name;Duration (h)\nA;0,75\nB;1.25', {
        format: FRENCH,
        projectName: 'Imported',
        fallbackStart: at(2026, 9, 28, 9),
      }),
    );
    expect(
      imported.project.tasks.map((task) =>
        task.kind === 'task' ? task.segments[0]?.durationHours : null,
      ),
    ).toEqual([0.75, 1.25]);
  });

  it('reads quarter hours in notations, and refuses other fractions', () => {
    expect(formatBlocks([{ durationHours: 1.5, gapDaysBefore: 0 }], new Map())).toBe('1.5h');
    expect(unwrap(parseBlocks('1.25h; +2d 0.5h', 10, 10)).segments).toEqual([
      { durationHours: 1.25, gapDaysBefore: 0 },
      { durationHours: 0.5, gapDaysBefore: 2 },
    ]);
    expect(parseBlocks('1.3h', 10, 10).ok).toBe(false);
    expect(unwrap(parsePredecessors('1SS-0.75h', 10))).toEqual([
      { wbs: '1', block: null, type: 'startToStart', lagHours: -0.75 },
    ]);
    expect(parsePredecessors('1+0.1h', 10).ok).toBe(false);
  });
});

describe('quarter hours in person or team conflicts', () => {
  it('finds the exact quarter hours two tasks of the same person share', () => {
    const alex = { id: 'alex', name: 'Alex', color: '#1baf7a', representsPersonOrTeam: true };
    const plan = project(
      [
        workTask('a', {
          tagId: 'alex',
          segments: [{ durationHours: 0.5, gapDaysBefore: 0 }],
          startNoEarlierThan: at(2026, 9, 28, 10),
        }),
        workTask('b', {
          tagId: 'alex',
          segments: [{ durationHours: 0.5, gapDaysBefore: 0 }],
          startNoEarlierThan: at(2026, 9, 28, 10) + 0.25,
        }),
      ],
      [],
      { tags: [alex] },
    );
    expect(scheduleOrThrow(plan).tagConflicts.conflicts).toEqual([
      {
        tagId: 'alex',
        start: at(2026, 9, 28, 10) + 0.25,
        end: at(2026, 9, 28, 10) + 0.5,
        taskIds: ['a', 'b'],
      },
    ]);
  });
});
