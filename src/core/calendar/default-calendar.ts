import type { WorkingCalendar } from '../model/calendar';
import { FRIDAY, MONDAY, THURSDAY, TUESDAY, WEDNESDAY } from '../time';

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 17;

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingWeekdays: [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY],
  workingTimeRanges: [{ startHour: DAY_START_HOUR, endHour: DAY_END_HOUR }],
  nonWorkingPeriods: [],
};
