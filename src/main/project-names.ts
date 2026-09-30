import { basename, extname } from 'node:path';
import { MAX_PROJECT_NAME_LENGTH } from '../core/limits';
import { toProjectHour, type ProjectHour } from '../core/time';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const FIRST_MONTH_OFFSET = 1;

/** Names a project after its file, without extension or control characters and within the length of a project name, a file name giving nothing leading to the fallback name. */
export function projectNameFromPath(path: string, fallbackName: string): string {
  const name = basename(path, extname(path)).replace(CONTROL_CHARACTERS, ' ').trim();
  const shortened = Array.from(name).slice(0, MAX_PROJECT_NAME_LENGTH).join('').trim();
  return shortened === '' ? fallbackName : shortened;
}

/** Returns the project hour of a moment in local time, or the fallback when the moment lies outside the supported years. */
export function localProjectHour(moment: Date, fallback: ProjectHour): ProjectHour {
  const hour = toProjectHour({
    year: moment.getFullYear(),
    month: moment.getMonth() + FIRST_MONTH_OFFSET,
    day: moment.getDate(),
    hour: moment.getHours(),
  });
  return hour.ok ? hour.value : fallback;
}
