import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import { valueAt } from '../table-value';
import type { Weekday } from '../time';

/** Writes a calendar the one way a shared document holds it: each list sorted by its values, without repeated items. */
export function canonicalCalendar(calendar: WorkingCalendar): WorkingCalendar {
  return {
    workingWeekdays: sortedUnique(calendar.workingWeekdays, (day: Weekday) => [day]),
    workingTimeRanges: sortedUnique(calendar.workingTimeRanges, (range: TimeRange) => [
      range.startHour,
      range.endHour,
    ]),
    nonWorkingPeriods: sortedUnique(calendar.nonWorkingPeriods, (period: DayRange) => [
      period.firstDay,
      period.lastDay,
    ]),
  };
}

/** Sorts items by the numbers that make them up and keeps one of each. */
function sortedUnique<T>(items: readonly T[], numbersOf: (item: T) => readonly number[]): T[] {
  const byKey = new Map(items.map((item) => [numbersOf(item).join(), item]));
  return [...byKey.values()].sort((left, right) =>
    compareNumbers(numbersOf(left), numbersOf(right)),
  );
}

/** Orders two lists of numbers of the same length by their first differing number. */
export function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (const [index, value] of left.entries()) {
    const difference = value - valueAt(right, index);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
