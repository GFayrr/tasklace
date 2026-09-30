import { DEFAULT_CALENDAR } from '../../core/calendar/default-calendar';
import type { Project } from '../../core/model/project';
import { createDefaultTags } from '../../core/tags/tag-palette';
import { MIN_PROJECT_HOUR, toProjectHour, type ProjectHour } from '../../core/time';

const FIRST_MONTH_OFFSET = 1;
const MIDNIGHT = 0;

/** Returns midnight of the local day of a moment, or the first supported hour for a clock outside the supported years. */
export function localDayStart(moment: Date): ProjectHour {
  const start = toProjectHour({
    year: moment.getFullYear(),
    month: moment.getMonth() + FIRST_MONTH_OFFSET,
    day: moment.getDate(),
    hour: MIDNIGHT,
  });
  return start.ok ? start.value : MIN_PROJECT_HOUR;
}

/** Returns the local hour of a moment as a project hour, or the first supported hour for a clock outside the supported years. */
export function localHourOf(moment: Date): ProjectHour {
  const hour = toProjectHour({
    year: moment.getFullYear(),
    month: moment.getMonth() + FIRST_MONTH_OFFSET,
    day: moment.getDate(),
    hour: moment.getHours(),
  });
  return hour.ok ? hour.value : MIN_PROJECT_HOUR;
}

/** Builds an empty project starting today, with the default calendar and tags, every advanced option turned off. */
export function buildNewProject(name: string, moment: Date, createId: () => string): Project {
  return {
    name,
    startDate: localDayStart(moment),
    calendar: DEFAULT_CALENDAR,
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
      alwaysShowPatterns: false,
    },
    tasks: [],
    dependencies: [],
    tags: createDefaultTags(createId),
    baseline: null,
  };
}
