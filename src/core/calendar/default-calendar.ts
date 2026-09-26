import type { WorkingCalendar } from '../model/calendar';
import { FRIDAY, MONDAY, THURSDAY, TUESDAY, WEDNESDAY } from '../time';

const MORNING_START_HOUR = 9;
const LUNCH_START_HOUR = 12;
const LUNCH_END_HOUR = 13;
const EVENING_END_HOUR = 17;

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingWeekdays: [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY],
  workingTimeRanges: [
    { startHour: MORNING_START_HOUR, endHour: LUNCH_START_HOUR },
    { startHour: LUNCH_END_HOUR, endHour: EVENING_END_HOUR },
  ],
  nonWorkingPeriods: [],
};
