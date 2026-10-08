import { describe, expect, it } from 'vitest';
import type { WorkingCalendar } from '../../core/model/calendar';
import type { Project } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSession } from '../../core/shared/shared-session';
import { at, dayOf as day } from '../../core/testing/civil-time';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import { SATURDAY, SUNDAY, MONDAY } from '../../core/time';
import { buildPlanOutline } from './plan-outline';
import {
  addNonWorkingPeriod,
  addTimeRange,
  dayRangeText,
  removeNonWorkingPeriod,
  removeTimeRange,
  renameProject,
  setNonWorkingPeriod,
  toggleProjectOption,
  setBaseline,
  clearBaseline,
  setProjectStart,
  setTimeRange,
  setWorkingWeekday,
  timeRangeText,
  workingHoursOf,
} from './project-commands';
import type { Edit, EditContext } from './task-commands';

const PLAN = project([workTask('a')], [], { startDate: at(2026, 10, 12, 8) });

/** Builds the edit context of a plan, with a calendar replaced in part when asked. */
function contextOf(change: Partial<WorkingCalendar> = {}): EditContext {
  const plan: Project = { ...PLAN, calendar: { ...PLAN.calendar, ...change } };
  return {
    project: plan,
    outline: buildPlanOutline(plan.tasks, new Set()),
    createId: () => 'new',
    dayHours: 7,
  };
}

/** Returns the calendar an edit writes, failing the test when it is refused or writes something else. */
function calendarOf(edit: Edit): WorkingCalendar {
  const [operation] = edit.ok ? edit.value : [];
  if (operation?.type !== 'updateProject' || operation.fields.calendar === undefined) {
    throw new Error(`The edit wrote no calendar: ${JSON.stringify(edit)}`);
  }
  return operation.fields.calendar;
}

describe('renameProject', () => {
  it('writes the name, leaving its checks to the shared session', () => {
    expect(renameProject('Master thesis')).toEqual({
      ok: true,
      value: [{ type: 'updateProject', fields: { name: 'Master thesis' } }],
    });
  });
});

describe('setProjectStart', () => {
  it('moves the start to a date and time as a date and time field gives it', () => {
    expect(setProjectStart(' 2026-10-19T09:15 ')).toEqual({
      ok: true,
      value: [{ type: 'updateProject', fields: { startDate: at(2026, 10, 19, 9) + 0.25 } }],
    });
    for (const text of ['', '2026-10-19', 'tomorrow', '2026-13-01T08:00', '2026-10-19T09:10']) {
      expect(setProjectStart(text)).toEqual({ ok: false, error: 'INVALID_DATE' });
    }
  });
});

describe('setWorkingWeekday', () => {
  it('works a weekday in order, or stops working it', () => {
    expect(calendarOf(setWorkingWeekday(contextOf(), SATURDAY, true)).workingWeekdays).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(calendarOf(setWorkingWeekday(contextOf(), SUNDAY, true)).workingWeekdays).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(calendarOf(setWorkingWeekday(contextOf(), MONDAY, false)).workingWeekdays).toEqual([
      2, 3, 4, 5,
    ]);
    expect(calendarOf(setWorkingWeekday(contextOf(), MONDAY, true)).workingWeekdays).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});

describe('working hours', () => {
  it('changes a range, midnight as an end meaning the end of the day', () => {
    expect(
      calendarOf(setTimeRange(contextOf(), 1, { start: '13:30', end: '18:45' })).workingTimeRanges,
    ).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 13.5, endHour: 18.75 },
    ]);
    expect(
      calendarOf(setTimeRange(contextOf(), 1, { start: '20:00', end: '00:00' })).workingTimeRanges,
    ).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 20, endHour: 24 },
    ]);
  });

  it('refuses a time that is not a quarter hour, and a range that does not exist', () => {
    for (const [start, end] of [
      ['13:10', '17:00'],
      ['13:00', ''],
      ['1 pm', '17:00'],
    ] as const) {
      expect(setTimeRange(contextOf(), 0, { start, end })).toEqual({
        ok: false,
        error: 'INVALID_TIME',
      });
    }
    for (const index of [-1, 2, 0.5]) {
      expect(setTimeRange(contextOf(), index, { start: '08:00', end: '09:00' })).toEqual({
        ok: false,
        error: 'NOT_POSSIBLE',
      });
      expect(removeTimeRange(contextOf(), index)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
    }
  });

  it('adds a range an hour after the latest one, refusing when the day has no room left', () => {
    expect(
      calendarOf(
        addTimeRange(
          contextOf({
            workingTimeRanges: [
              { startHour: 13, endHour: 17 },
              { startHour: 8, endHour: 12 },
            ],
          }),
        ),
      ).workingTimeRanges[2],
    ).toEqual({ startHour: 18, endHour: 19 });
    expect(calendarOf(addTimeRange(contextOf())).workingTimeRanges).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 13, endHour: 17 },
      { startHour: 18, endHour: 19 },
    ]);
    expect(
      calendarOf(addTimeRange(contextOf({ workingTimeRanges: [] }))).workingTimeRanges,
    ).toEqual([{ startHour: 1, endHour: 2 }]);
    expect(
      addTimeRange(contextOf({ workingTimeRanges: [{ startHour: 8, endHour: 22.25 }] })),
    ).toEqual({ ok: false, error: 'NO_ROOM_FOR_RANGE' });
    expect(
      calendarOf(addTimeRange(contextOf({ workingTimeRanges: [{ startHour: 8, endHour: 22 }] })))
        .workingTimeRanges,
    ).toEqual([
      { startHour: 8, endHour: 22 },
      { startHour: 23, endHour: 24 },
    ]);
  });

  it('removes a range', () => {
    expect(calendarOf(removeTimeRange(contextOf(), 0)).workingTimeRanges).toEqual([
      { startHour: 13, endHour: 17 },
    ]);
  });

  it('adds up the working hours of a day', () => {
    expect(workingHoursOf(contextOf().project.calendar)).toBe(7);
    expect(
      workingHoursOf({
        ...contextOf().project.calendar,
        workingTimeRanges: [{ startHour: 8.25, endHour: 12 }],
      }),
    ).toBe(3.75);
  });

  it('writes a range as the time fields show it, the end of the day as midnight', () => {
    expect(timeRangeText({ startHour: 8.25, endHour: 24 })).toEqual({
      start: '08:15',
      end: '00:00',
    });
  });
});

describe('days off', () => {
  const twoPeriods = {
    nonWorkingPeriods: [
      { firstDay: day(2026, 12, 24), lastDay: day(2027, 1, 1) },
      { firstDay: day(2027, 4, 5), lastDay: day(2027, 4, 5) },
    ],
  };

  it('changes a period, an empty last day meaning a single day', () => {
    expect(
      calendarOf(setNonWorkingPeriod(contextOf(twoPeriods), 1, { first: '2027-05-01', last: '' }))
        .nonWorkingPeriods[1],
    ).toEqual({ firstDay: day(2027, 5, 1), lastDay: day(2027, 5, 1) });
    expect(
      calendarOf(
        setNonWorkingPeriod(contextOf(twoPeriods), 0, { first: '2026-12-21', last: '2027-01-02' }),
      ).nonWorkingPeriods[0],
    ).toEqual({ firstDay: day(2026, 12, 21), lastDay: day(2027, 1, 2) });
  });

  it('refuses an unreadable day, and a period that does not exist', () => {
    expect(setNonWorkingPeriod(contextOf(twoPeriods), 0, { first: 'soon', last: '' })).toEqual({
      ok: false,
      error: 'INVALID_DATE',
    });
    expect(
      setNonWorkingPeriod(contextOf(twoPeriods), 0, { first: '2027-05-01', last: 'later' }),
    ).toEqual({ ok: false, error: 'INVALID_DATE' });
    for (const index of [-1, 2, 0.5]) {
      expect(
        setNonWorkingPeriod(contextOf(twoPeriods), index, { first: '2027-05-01', last: '' }),
      ).toEqual({
        ok: false,
        error: 'NOT_POSSIBLE',
      });
      expect(removeNonWorkingPeriod(contextOf(twoPeriods), index)).toEqual({
        ok: false,
        error: 'NOT_POSSIBLE',
      });
    }
  });

  it('adds the day after the latest period off, or the first day of the project', () => {
    const unordered = { nonWorkingPeriods: [...twoPeriods.nonWorkingPeriods].reverse() };
    expect(calendarOf(addNonWorkingPeriod(contextOf(unordered))).nonWorkingPeriods[2]).toEqual({
      firstDay: day(2027, 4, 6),
      lastDay: day(2027, 4, 6),
    });
    expect(calendarOf(addNonWorkingPeriod(contextOf(twoPeriods))).nonWorkingPeriods[2]).toEqual({
      firstDay: day(2027, 4, 6),
      lastDay: day(2027, 4, 6),
    });
    expect(calendarOf(addNonWorkingPeriod(contextOf())).nonWorkingPeriods).toEqual([
      { firstDay: day(2026, 10, 12), lastDay: day(2026, 10, 12) },
    ]);
  });

  it('removes a period, and writes one as the date fields show it', () => {
    expect(calendarOf(removeNonWorkingPeriod(contextOf(twoPeriods), 0)).nonWorkingPeriods).toEqual([
      { firstDay: day(2027, 4, 5), lastDay: day(2027, 4, 5) },
    ]);
    expect(dayRangeText({ firstDay: day(2026, 12, 24), lastDay: day(2027, 1, 1) })).toEqual({
      first: '2026-12-24',
      last: '2027-01-01',
    });
    expect(dayRangeText({ firstDay: day(2027, 4, 5), lastDay: day(2027, 4, 5) })).toEqual({
      first: '2027-04-05',
      last: '',
    });
  });
});

describe('a calendar change applied to a session', () => {
  it('is accepted by the project, keeping the rest of the calendar', () => {
    const opened = openSharedSession(createSharedDocument(PLAN, TEST_DOCUMENT_ID));
    if (!opened.ok) {
      throw new Error(JSON.stringify(opened.error));
    }
    const edit = addNonWorkingPeriod(contextOf());
    expect(edit.ok && opened.value.applyAll(edit.value)).toEqual({ ok: true, value: undefined });
    expect(opened.value.project().calendar).toEqual({
      ...PLAN.calendar,
      nonWorkingPeriods: [{ firstDay: day(2026, 10, 12), lastDay: day(2026, 10, 12) }],
    });
  });
});

describe('setBaseline and clearBaseline', () => {
  it('replace the baseline of the project, or remove it', () => {
    const baseline = {
      takenAt: at(2026, 10, 6, 10),
      entries: [
        { taskId: 'a', start: at(2026, 10, 12, 8), end: at(2026, 10, 12, 17), durationHours: 9 },
      ],
    };
    expect(setBaseline(baseline)).toEqual({
      ok: true,
      value: [{ type: 'updateProject', fields: { baseline } }],
    });
    expect(clearBaseline()).toEqual({
      ok: true,
      value: [{ type: 'updateProject', fields: { baseline: null } }],
    });
  });
});

describe('toggleProjectOption', () => {
  it('turns one option on when off and off when on, keeping the others', () => {
    expect(toggleProjectOption(contextOf(), 'criticalPathEnabled')).toEqual({
      ok: true,
      value: [
        {
          type: 'updateProject',
          fields: { options: { ...PLAN.options, criticalPathEnabled: true } },
        },
      ],
    });
    const on = {
      ...contextOf(),
      project: { ...PLAN, options: { ...PLAN.options, dateConstraintsEnabled: true } },
    };
    expect(toggleProjectOption(on, 'dateConstraintsEnabled')).toEqual({
      ok: true,
      value: [{ type: 'updateProject', fields: { options: PLAN.options } }],
    });
  });
});
