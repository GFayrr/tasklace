import { describe, expect, it } from 'vitest';
import { TEST_CALENDAR } from '../../core/testing/test-calendar';
import { at, compileOrThrow, dayOf } from '../../core/testing/civil-time';
import { paleColor } from './tag-styles';
import { nonWorkingIntervals, previewSpan, splitAtDaysOff, visibleRows } from './timeline-painter';
import type { RowShape } from './timeline-geometry';
import { ROW_HEIGHT } from './timeline-geometry';

const CALENDAR = compileOrThrow(TEST_CALENDAR);

describe('visibleRows', () => {
  it('lists the rows a viewport shows, even partly, within the rows that exist', () => {
    expect(
      visibleRows({ left: 0, top: ROW_HEIGHT + 1, width: 10, height: ROW_HEIGHT * 2 }, 100),
    ).toEqual({
      first: 1,
      last: 3,
    });
    expect(visibleRows({ left: 0, top: 0, width: 10, height: ROW_HEIGHT * 10 }, 3)).toEqual({
      first: 0,
      last: 2,
    });
  });
});

describe('nonWorkingIntervals', () => {
  it('shades whole weekends at the day zoom', () => {
    expect(nonWorkingIntervals(CALENDAR, [], at(2026, 10, 2), at(2026, 10, 6), 'day')).toEqual([
      { start: at(2026, 10, 3), end: at(2026, 10, 5) },
    ]);
  });

  it('also shades nights and breaks at the hour zoom', () => {
    expect(
      nonWorkingIntervals(CALENDAR, [], at(2026, 10, 5, 8), at(2026, 10, 5, 20), 'hour'),
    ).toEqual([
      { start: at(2026, 10, 5, 0), end: at(2026, 10, 5, 9) },
      { start: at(2026, 10, 5, 12), end: at(2026, 10, 5, 13) },
      { start: at(2026, 10, 5, 17), end: at(2026, 10, 6, 0) },
    ]);
  });
});

describe('nonWorkingIntervals at the month zoom', () => {
  it('shades only the periods off entered by the user, merged when they touch', () => {
    const periods = [
      { firstDay: dayOf(2026, 12, 28), lastDay: dayOf(2026, 12, 31) },
      { firstDay: dayOf(2026, 12, 24), lastDay: dayOf(2026, 12, 27) },
      { firstDay: dayOf(2025, 1, 1), lastDay: dayOf(2025, 1, 2) },
    ];
    expect(
      nonWorkingIntervals(CALENDAR, periods, at(2026, 12, 1), at(2027, 1, 31), 'month'),
    ).toEqual([{ start: at(2026, 12, 24), end: at(2027, 1, 1) }]);
  });
});

describe('paleColor', () => {
  it('mixes a color with white', () => {
    expect(paleColor('#000000', 0.5)).toBe('#808080');
    expect(paleColor('#2a78d6', 0)).toBe('#2a78d6');
    expect(paleColor('#2a78d6', 1)).toBe('#ffffff');
  });
});

describe('splitAtDaysOff', () => {
  it('splits a span crossing a weekend into the worked parts and the weekend', () => {
    expect(splitAtDaysOff(CALENDAR, at(2026, 10, 2, 9), at(2026, 10, 6, 17))).toEqual({
      parts: [
        { start: at(2026, 10, 2, 9), end: at(2026, 10, 3) },
        { start: at(2026, 10, 5), end: at(2026, 10, 6, 17) },
      ],
      daysOff: [{ start: at(2026, 10, 3), end: at(2026, 10, 5) }],
    });
  });

  it('keeps a span within working days whole, nights included', () => {
    expect(splitAtDaysOff(CALENDAR, at(2026, 10, 5, 9), at(2026, 10, 7, 12))).toEqual({
      parts: [{ start: at(2026, 10, 5, 9), end: at(2026, 10, 7, 12) }],
      daysOff: [],
    });
  });
});

describe('previewSpan', () => {
  const shape: Extract<RowShape, { kind: 'task' }> = {
    kind: 'task',
    taskId: 't',
    row: 0,
    segments: [
      { x: 100, width: 40, filled: 0 },
      { x: 200, width: 60, filled: 0 },
    ],
    start: 100,
    end: 260,
  };

  it('shifts only the block moved alone, keeping its width', () => {
    expect(previewSpan(shape, { kind: 'move', shape, offset: 30, block: 1 })).toEqual({
      start: 230,
      width: 60,
    });
  });

  it('shifts the whole bar when no block, or a block the bar does not show, is moved', () => {
    const whole = { start: 130, width: 160 };
    expect(previewSpan(shape, { kind: 'move', shape, offset: 30, block: null })).toEqual(whole);
    expect(previewSpan(shape, { kind: 'move', shape, offset: 30, block: 5 })).toEqual(whole);
  });

  it('widens a stretched bar, keeping at least one pixel', () => {
    expect(previewSpan(shape, { kind: 'stretch', shape, offset: 20 })).toEqual({
      start: 100,
      width: 180,
    });
    expect(previewSpan(shape, { kind: 'stretch', shape, offset: -500 })).toEqual({
      start: 100,
      width: 1,
    });
  });
});
