import type { DayIndex, Weekday } from '../time';

export interface TimeRange {
  readonly startHour: number;
  readonly endHour: number;
}

export interface DayRange {
  readonly firstDay: DayIndex;
  readonly lastDay: DayIndex;
}

export interface WorkingCalendar {
  readonly workingWeekdays: readonly Weekday[];
  readonly workingTimeRanges: readonly TimeRange[];
  readonly nonWorkingPeriods: readonly DayRange[];
}
