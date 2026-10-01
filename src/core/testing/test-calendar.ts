import type { WorkingCalendar } from '../model/calendar';
import { FRIDAY, MONDAY, THURSDAY, TUESDAY, WEDNESDAY } from '../time';

export const TEST_CALENDAR: WorkingCalendar = {
  workingWeekdays: [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY],
  workingTimeRanges: [
    { startHour: 9, endHour: 12 },
    { startHour: 13, endHour: 17 },
  ],
  nonWorkingPeriods: [],
};
