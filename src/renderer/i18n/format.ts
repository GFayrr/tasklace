import type { Schedule } from '../../core/scheduling/schedule-project';
import type { ProjectHour } from '../../core/time';

export interface ProjectSpan {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

const MILLISECONDS_PER_HOUR = 3_600_000;

/** Creates a function writing the day of a project hour in the regional format, project hours being wall-clock times without time zone. */
export function createDayFormatter(locale: string): (hour: ProjectHour) => string {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  return (hour) => format.format(new Date(hour * MILLISECONDS_PER_HOUR));
}

/** Returns the earliest start and the latest end of the tasks of a schedule, or null when it places no task. */
export function projectSpan(schedule: Schedule): ProjectSpan | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const placement of schedule.placements.values()) {
    start = Math.min(start, placement.start);
    end = Math.max(end, placement.end);
  }
  return schedule.placements.size === 0 ? null : { start, end };
}
