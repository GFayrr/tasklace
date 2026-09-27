import { formatDate, formatDateTime, parseDate, parseDateTime } from '../civil-format';
import { MAX_PROJECT_DATA_BYTES } from '../limits';
import type { WorkingCalendar } from '../model/calendar';
import type { Project, Task } from '../model/project';
import { failure, success, type Result } from '../result';
import type { DayIndex, ProjectHour, Weekday } from '../time';
import { readProject, type ValueCodec } from '../validation/read-project';
import {
  createIssueList,
  type IssueList,
  type ValidationIssue,
} from '../validation/validation-issues';
import {
  childField,
  readEnum,
  readInteger,
  readRawString,
  readRecord,
  type Field,
} from '../validation/value-readers';

export const PROJECT_JSON_FORMAT = 'tasklace';
export const PROJECT_JSON_VERSION = 1;

const DOCUMENT_KEYS = ['format', 'version', 'project'];
const JSON_INDENTATION = 2;
const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const JSON_VALUE_CODEC: ValueCodec = {
  readInstant: (field, issues) => readDateText(field, issues, parseDateTime),
  readDay: (field, issues) => readDateText(field, issues, parseDate),
  readWeekday: (field, issues) => {
    const name = readEnum(field, issues, WEEKDAY_NAMES);
    return name === undefined ? undefined : (WEEKDAY_NAMES.indexOf(name) as Weekday);
  },
};

/** Writes a project as readable, versioned JSON with dates in clear text. */
export function exportProjectJson(project: Project): string {
  const document = {
    format: PROJECT_JSON_FORMAT,
    version: PROJECT_JSON_VERSION,
    project: {
      name: project.name,
      startDate: formatDateTime(project.startDate),
      calendar: calendarToJson(project.calendar),
      options: project.options,
      tags: project.tags,
      tasks: project.tasks.map(taskToJson),
      dependencies: project.dependencies,
    },
  };
  return JSON.stringify(document, null, JSON_INDENTATION);
}

/** Reads a project from untrusted JSON text, or lists every problem with its location. */
export function importProjectJson(text: string): Result<Project, readonly ValidationIssue[]> {
  if (text.length > MAX_PROJECT_DATA_BYTES) {
    return failure([{ path: '', code: 'TOO_LARGE' }]);
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return failure([{ path: '', code: 'INVALID_JSON' }]);
  }
  const issues = createIssueList();
  const document = readRecord({ value: parsed.value, path: '' }, issues, DOCUMENT_KEYS);
  if (document === undefined || !hasSupportedHeader(document, issues)) {
    return failure(issues.issues);
  }
  return readProject(childField(document, 'project', '').value, JSON_VALUE_CODEC, 'project');
}

/** Parses JSON text, turning a syntax error into a failed result. */
function parseJson(text: string): Result<unknown, 'INVALID_JSON'> {
  try {
    return success(JSON.parse(text) as unknown);
  } catch {
    return failure('INVALID_JSON');
  }
}

/** Checks the format name and the version of an imported document. */
function hasSupportedHeader(
  document: Readonly<Record<string, unknown>>,
  issues: IssueList,
): boolean {
  const format = readRawString(childField(document, 'format', ''), issues);
  if (format !== undefined && format !== PROJECT_JSON_FORMAT) {
    issues.add('format', 'UNSUPPORTED_FORMAT');
  }
  const version = readInteger(
    childField(document, 'version', ''),
    issues,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (version !== undefined && version !== PROJECT_JSON_VERSION) {
    issues.add('version', 'UNSUPPORTED_VERSION');
  }
  return issues.issues.length === 0;
}

/** Reads a date written as text with a given parser. */
function readDateText<T extends ProjectHour | DayIndex>(
  field: Field,
  issues: IssueList,
  parse: (text: string) => Result<T, 'INVALID_DATE_TIME'>,
): T | undefined {
  const text = readRawString(field, issues);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parse(text);
  if (!parsed.ok) {
    issues.add(field.path, 'INVALID_DATE');
    return undefined;
  }
  return parsed.value;
}

/** Writes a calendar with weekday names and dates in clear text. */
function calendarToJson(calendar: WorkingCalendar) {
  return {
    workingWeekdays: calendar.workingWeekdays.map((weekday) => WEEKDAY_NAMES[weekday]),
    workingTimeRanges: calendar.workingTimeRanges,
    nonWorkingPeriods: calendar.nonWorkingPeriods.map((period) => ({
      firstDay: formatDate(period.firstDay),
      lastDay: formatDate(period.lastDay),
    })),
  };
}

/** Writes a task with its dates in clear text. */
function taskToJson(task: Task) {
  if (task.kind === 'summary') {
    return task;
  }
  const clearDate = (hour: ProjectHour | null): string | null =>
    hour === null ? null : formatDateTime(hour);
  return {
    ...task,
    startNoEarlierThan: clearDate(task.startNoEarlierThan),
    mustFinishOn: clearDate(task.mustFinishOn),
    deadline: clearDate(task.deadline),
  };
}
