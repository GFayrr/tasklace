import { basename, extname } from 'node:path';
import { MAX_PROJECT_NAME_LENGTH } from '../core/limits';
import { toProjectHour, type ProjectHour } from '../core/time';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const FORBIDDEN_IN_FILE_NAMES = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³])$/i;
const NAME_PART_SEPARATOR = '.';
const RESERVED_NAME_SUFFIX = '_';
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

/** Turns a project name into a file name with an extension, without the characters file systems forbid, a name starting with a device name Windows reserves getting a suffix, and the fallback name standing in for a name left empty. */
export function fileNameForProject(name: string, extension: string, fallbackName: string): string {
  const shortened = Array.from(name.replace(FORBIDDEN_IN_FILE_NAMES, ' '))
    .slice(0, MAX_PROJECT_NAME_LENGTH)
    .join('');
  const cleaned = shortened.trim().replace(TRAILING_DOTS_AND_SPACES, '');
  const base = cleaned === '' ? fallbackName : cleaned;
  const [device = '', ...rest] = base.split(NAME_PART_SEPARATOR);
  const allowed = RESERVED_WINDOWS_NAMES.test(device.trim())
    ? [`${device}${RESERVED_NAME_SUFFIX}`, ...rest].join(NAME_PART_SEPARATOR)
    : base;
  return `${allowed}.${extension}`;
}

/** Adds an extension to a path that does not already end with it, whatever its case. */
export function withExtension(path: string, extension: string): string {
  return extname(path).toLowerCase() === `.${extension}` ? path : `${path}.${extension}`;
}
