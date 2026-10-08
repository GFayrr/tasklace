import { describe, expect, it } from 'vitest';
import { dayIndexOf, toProjectHour } from '../../core/time';
import { formatTableDateTime, isPickerRefusal, parseTableDate } from './table-dates';

/** Returns the project hour of a wall-clock time, failing the test for an impossible one. */
function hourOf(year: number, month: number, day: number, hour: number, minute = 0): number {
  const result = toProjectHour({ year, month, day, hour, minute });
  if (!result.ok) {
    throw new Error('Impossible test time');
  }
  return result.value;
}

describe('table dates', () => {
  it('writes an instant as an ISO date and time that reads back to the same instant', () => {
    const hour = hourOf(2026, 10, 5, 14, 45);
    expect(formatTableDateTime(hour)).toBe('2026-10-05 14:45');
    expect(parseTableDate(formatTableDateTime(hour))).toEqual({
      ok: true,
      value: { kind: 'dateTime', hour },
    });
  });

  it('reads a day alone, or a time after a space or a "T", ignoring surrounding spaces', () => {
    const hour = toProjectHour({ year: 2026, month: 10, day: 5, hour: 0 });
    expect(hour.ok).toBe(true);
    expect(parseTableDate(' 2026-10-05 ')).toEqual({
      ok: true,
      value: { kind: 'date', day: hour.ok ? dayIndexOf(hour.value) : -1 },
    });
    expect(parseTableDate('2026-10-05T08:15')).toEqual({
      ok: true,
      value: { kind: 'dateTime', hour: hourOf(2026, 10, 5, 8, 15) },
    });
  });

  it.each([
    '',
    '05/10/2026',
    '10/05/2026',
    '2026/10/05',
    '2026-10-5',
    '2026-10-05 8:00',
    '2026-10-05 08:10',
    '2026-02-30',
    '2026-10-05  08:00',
    '2026-10-05 24:00',
    'soon',
  ])('refuses "%s", which is not an ISO date of a real quarter hour', (text) => {
    expect(parseTableDate(text)).toEqual({ ok: false, error: 'INVALID_DATE' });
  });
});

describe('isPickerRefusal', () => {
  it('recognizes only the refusals of the browser to show its calendar', () => {
    expect(isPickerRefusal(new DOMException('No gesture', 'NotAllowedError'))).toBe(true);
    expect(isPickerRefusal(new DOMException('No calendar', 'NotSupportedError'))).toBe(true);
    expect(isPickerRefusal(new DOMException('Hidden', 'InvalidStateError'))).toBe(false);
    expect(isPickerRefusal(new TypeError('showPicker is not a function'))).toBe(false);
    expect(isPickerRefusal('NotAllowedError')).toBe(false);
  });
});
