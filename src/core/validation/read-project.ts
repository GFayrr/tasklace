import {
  compileCalendar,
  type CalendarErrorCode,
  type CompiledCalendar,
} from '../calendar/compile-calendar';
import { computeDailyWindow, type DailyWindowErrorCode } from '../calendar/task-slots';
import {
  MAX_DEPENDENCIES,
  MAX_LAG_HOURS,
  MAX_NON_WORKING_PERIODS,
  MAX_PROJECT_NAME_LENGTH,
  MAX_SEGMENTS_PER_TASK,
  MAX_SEGMENT_GAP_DAYS,
  MAX_SORT_KEY_LENGTH,
  MAX_TAGS,
  MAX_TAG_NAME_LENGTH,
  MAX_TASKS,
  MAX_TASK_DURATION_HOURS,
  MAX_TASK_NAME_LENGTH,
  MAX_WORKING_TIME_RANGES,
} from '../limits';
import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import type {
  Baseline,
  BaselineEntry,
  Dependency,
  DependencyType,
  Milestone,
  Project,
  ProjectOptions,
  Tag,
  Task,
  TaskSegment,
  WorkTask,
} from '../model/project';
import { failure, success, type Result } from '../result';
import { analyzeStructureWithinLimits } from '../scheduling/project-structure';
import { isHexColor } from '../tags/color-vision';
import {
  DAYS_PER_WEEK,
  END_PROJECT_HOUR,
  HOURS_PER_DAY,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  MIN_PROJECT_HOUR,
  SATURDAY,
  SUNDAY,
  WEEKDAYS,
  type DayIndex,
  type ProjectHour,
  type Weekday,
} from '../time';
import { createIssueList, type IssueList, type ValidationIssue } from './validation-issues';
import {
  childField,
  itemField,
  readArray,
  readBoolean,
  readEnum,
  readIdentifier,
  readInteger,
  readNullable,
  readPatternString,
  readPlainObject,
  readRawString,
  readRecord,
  readText,
  reportUnknownKeys,
  type Field,
  type UnknownRecord,
} from './value-readers';

export interface ValueCodec {
  readonly readInstant: (field: Field, issues: IssueList) => ProjectHour | undefined;
  readonly readDay: (field: Field, issues: IssueList) => DayIndex | undefined;
  readonly readWeekday: (field: Field, issues: IssueList) => Weekday | undefined;
}

export const STORED_VALUE_CODEC: ValueCodec = {
  readInstant: (field, issues) =>
    readInteger(field, issues, MIN_PROJECT_HOUR, END_PROJECT_HOUR - 1),
  readDay: (field, issues) => readInteger(field, issues, MIN_DAY_INDEX, MAX_DAY_INDEX),
  readWeekday: (field, issues) => {
    const day = readInteger(field, issues, SUNDAY, SATURDAY);
    return day === undefined ? undefined : WEEKDAYS[day];
  },
};

const PROJECT_KEYS = [
  'name',
  'startDate',
  'calendar',
  'options',
  'tags',
  'tasks',
  'dependencies',
  'baseline',
];
const CALENDAR_KEYS = ['workingWeekdays', 'workingTimeRanges', 'nonWorkingPeriods'];
const TIME_RANGE_KEYS = ['startHour', 'endHour'];
const DAY_RANGE_KEYS = ['firstDay', 'lastDay'];
const OPTION_KEYS = ['criticalPathEnabled', 'dateConstraintsEnabled', 'alwaysShowPatterns'];
export const TAG_KEYS = ['id', 'name', 'color', 'representsPersonOrTeam'];
const SUMMARY_KEYS = ['id', 'kind', 'name', 'parentId', 'sortKey'];
const MILESTONE_KEYS = [
  ...SUMMARY_KEYS,
  'progressPercent',
  'tagId',
  'startNoEarlierThan',
  'mustFinishOn',
  'deadline',
];
export const WORK_TASK_KEYS = [...MILESTONE_KEYS, 'segments', 'hoursPerDay', 'dailyStartHour'];

export interface ListLimits {
  readonly tasks: number;
  readonly dependencies: number;
  readonly tags: number;
}

export const NOMINAL_LIST_LIMITS: ListLimits = {
  tasks: MAX_TASKS,
  dependencies: MAX_DEPENDENCIES,
  tags: MAX_TAGS,
};

export const TASK_KEYS_BY_KIND: Readonly<Record<Task['kind'], readonly string[]>> = {
  summary: SUMMARY_KEYS,
  milestone: MILESTONE_KEYS,
  task: WORK_TASK_KEYS,
};
const SEGMENT_KEYS = ['durationHours', 'gapDaysBefore'];
const BASELINE_KEYS = ['takenAt', 'entries'];
const BASELINE_ENTRY_KEYS = ['taskId', 'start', 'end', 'durationHours'];
const MAX_BASELINE_DURATION_HOURS = END_PROJECT_HOUR - MIN_PROJECT_HOUR;
export const DEPENDENCY_KEYS = ['id', 'predecessorId', 'successorId', 'type', 'lagHours'];
const TASK_KINDS = ['task', 'milestone', 'summary'] as const;
const DEPENDENCY_TYPES: readonly DependencyType[] = [
  'finishToStart',
  'startToStart',
  'finishToFinish',
  'startToFinish',
];
const DAILY_WINDOW_FIELDS: Readonly<Record<DailyWindowErrorCode, keyof WorkTask>> = {
  INVALID_HOURS_PER_DAY: 'hoursPerDay',
  INVALID_DAILY_START_HOUR: 'dailyStartHour',
};
const CALENDAR_ERROR_LISTS: Readonly<Record<CalendarErrorCode, keyof WorkingCalendar>> = {
  NO_WORKING_WEEKDAY: 'workingWeekdays',
  INVALID_WEEKDAY: 'workingWeekdays',
  DUPLICATE_WEEKDAY: 'workingWeekdays',
  NO_WORKING_TIME_RANGE: 'workingTimeRanges',
  TOO_MANY_WORKING_TIME_RANGES: 'workingTimeRanges',
  INVALID_WORKING_TIME_RANGE: 'workingTimeRanges',
  OVERLAPPING_WORKING_TIME_RANGES: 'workingTimeRanges',
  TOO_MANY_NON_WORKING_PERIODS: 'nonWorkingPeriods',
  INVALID_NON_WORKING_PERIOD: 'nonWorkingPeriods',
};
const SORT_KEY_PATTERN = /^[0-9A-Za-z]+$/;
const FULL_PROGRESS = 100;
const LAST_HOUR_OF_DAY = HOURS_PER_DAY - 1;

/** Validates untrusted data and turns it into a project, or lists the problems found with their locations. */
export function readProject(
  input: unknown,
  codec: ValueCodec,
  rootPath = '',
): Result<Project, readonly ValidationIssue[]> {
  const issues = createIssueList();
  const project = readProjectFields(
    { value: input, path: rootPath },
    issues,
    codec,
    NOMINAL_LIST_LIMITS,
  );
  if (project === undefined) {
    return failure(issues.issues);
  }
  reportSemanticIssues(project, issues, rootPath);
  return issues.issues.length > 0 ? failure(issues.issues) : success(project);
}

/** Validates every field of untrusted data, with given list limits, without checking the calendar, the daily patterns or the structure. */
export function readProjectShape(
  input: unknown,
  codec: ValueCodec,
  limits: ListLimits,
): Result<Project, readonly ValidationIssue[]> {
  const issues = createIssueList();
  const project = readProjectFields({ value: input, path: '' }, issues, codec, limits);
  return project === undefined || issues.issues.length > 0
    ? failure(issues.issues)
    : success(project);
}

/** Reads every field of a project, returning nothing when one of them is invalid. */
function readProjectFields(
  field: Field,
  issues: IssueList,
  codec: ValueCodec,
  limits: ListLimits,
): Project | undefined {
  const record = readRecord(field, issues, PROJECT_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const project = {
    name: readText(child('name'), issues, MAX_PROJECT_NAME_LENGTH),
    startDate: codec.readInstant(child('startDate'), issues),
    calendar: readCalendar(child('calendar'), issues, codec),
    options: readOptions(child('options'), issues),
    tags: readList(child('tags'), issues, limits.tags, readTag),
    tasks: readList(child('tasks'), issues, limits.tasks, (item, list) =>
      readTask(item, list, codec),
    ),
    dependencies: readList(child('dependencies'), issues, limits.dependencies, readDependency),
    baseline: readNullable(child('baseline'), issues, (item, list) =>
      readBaseline(item, list, codec),
    ),
  };
  return allDefined(project) ? project : undefined;
}

/** Reads the working weekdays, daily time ranges and non-working periods of a calendar. */
function readCalendar(
  field: Field,
  issues: IssueList,
  codec: ValueCodec,
): WorkingCalendar | undefined {
  const record = readRecord(field, issues, CALENDAR_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const calendar = {
    workingWeekdays: readList(child('workingWeekdays'), issues, DAYS_PER_WEEK, codec.readWeekday),
    workingTimeRanges: readList(
      child('workingTimeRanges'),
      issues,
      MAX_WORKING_TIME_RANGES,
      readTimeRange,
    ),
    nonWorkingPeriods: readList(
      child('nonWorkingPeriods'),
      issues,
      MAX_NON_WORKING_PERIODS,
      (item, list) => readDayRange(item, list, codec),
    ),
  };
  return allDefined(calendar) ? calendar : undefined;
}

/** Reads one daily working time range made of whole hours. */
function readTimeRange(field: Field, issues: IssueList): TimeRange | undefined {
  const record = readRecord(field, issues, TIME_RANGE_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const range = {
    startHour: readInteger(
      childField(record, 'startHour', field.path),
      issues,
      0,
      LAST_HOUR_OF_DAY,
    ),
    endHour: readInteger(childField(record, 'endHour', field.path), issues, 1, HOURS_PER_DAY),
  };
  return allDefined(range) ? range : undefined;
}

/** Reads one non-working period given by its first and last days. */
function readDayRange(field: Field, issues: IssueList, codec: ValueCodec): DayRange | undefined {
  const record = readRecord(field, issues, DAY_RANGE_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const range = {
    firstDay: codec.readDay(childField(record, 'firstDay', field.path), issues),
    lastDay: codec.readDay(childField(record, 'lastDay', field.path), issues),
  };
  return allDefined(range) ? range : undefined;
}

/** Reads the project options, all of them switches. */
function readOptions(field: Field, issues: IssueList): ProjectOptions | undefined {
  const record = readRecord(field, issues, OPTION_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const options = {
    criticalPathEnabled: readBoolean(child('criticalPathEnabled'), issues),
    dateConstraintsEnabled: readBoolean(child('dateConstraintsEnabled'), issues),
    alwaysShowPatterns: readBoolean(child('alwaysShowPatterns'), issues),
  };
  return allDefined(options) ? options : undefined;
}

/** Reads one tag with its name, color and person or team flag. */
function readTag(field: Field, issues: IssueList): Tag | undefined {
  const record = readRecord(field, issues, TAG_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const tag = {
    id: readIdentifier(child('id'), issues),
    name: readText(child('name'), issues, MAX_TAG_NAME_LENGTH),
    color: readColor(child('color'), issues),
    representsPersonOrTeam: readBoolean(child('representsPersonOrTeam'), issues),
  };
  return allDefined(tag) ? tag : undefined;
}

/** Reads a #RRGGBB color. */
function readColor(field: Field, issues: IssueList): string | undefined {
  const text = readRawString(field, issues);
  if (text !== undefined && !isHexColor(text)) {
    issues.add(field.path, 'INVALID_COLOR');
    return undefined;
  }
  return text;
}

/** Reads a task of any kind, checking that it only has the fields of its kind. */
function readTask(field: Field, issues: IssueList, codec: ValueCodec): Task | undefined {
  const record = readPlainObject(field, issues);
  if (record === undefined) {
    return undefined;
  }
  const kind = readEnum(childField(record, 'kind', field.path), issues, TASK_KINDS);
  if (kind === 'summary') {
    return readSummaryTask(record, field.path, issues);
  }
  if (kind === 'milestone') {
    return readMilestone(record, field.path, issues, codec);
  }
  if (kind === 'task') {
    return readWorkTask(record, field.path, issues, codec);
  }
  reportUnknownKeys(record, field.path, issues, WORK_TASK_KEYS);
  return undefined;
}

/** Reads the fields shared by every kind of task. */
function readTaskBase(record: UnknownRecord, path: string, issues: IssueList) {
  const child = (key: string): Field => childField(record, key, path);
  return {
    id: readIdentifier(child('id'), issues),
    name: readText(child('name'), issues, MAX_TASK_NAME_LENGTH),
    parentId: readNullable(child('parentId'), issues, readIdentifier),
    sortKey: readPatternString(child('sortKey'), issues, SORT_KEY_PATTERN, MAX_SORT_KEY_LENGTH),
  };
}

/** Reads a summary task, which only has the shared fields. */
function readSummaryTask(record: UnknownRecord, path: string, issues: IssueList): Task | undefined {
  reportUnknownKeys(record, path, issues, SUMMARY_KEYS);
  const summary = { kind: 'summary' as const, ...readTaskBase(record, path, issues) };
  return allDefined(summary) ? summary : undefined;
}

/** Reads the fields shared by milestones and work tasks: progress, tag and dates. */
function readDatedFields(
  record: UnknownRecord,
  path: string,
  issues: IssueList,
  codec: ValueCodec,
) {
  const child = (key: string): Field => childField(record, key, path);
  return {
    ...readTaskBase(record, path, issues),
    progressPercent: readInteger(child('progressPercent'), issues, 0, FULL_PROGRESS),
    tagId: readNullable(child('tagId'), issues, readIdentifier),
    startNoEarlierThan: readNullable(child('startNoEarlierThan'), issues, codec.readInstant),
    mustFinishOn: readNullable(child('mustFinishOn'), issues, codec.readInstant),
    deadline: readNullable(child('deadline'), issues, codec.readInstant),
  };
}

/** Reads a milestone, whose progress can only be 0 or 100. */
function readMilestone(
  record: UnknownRecord,
  path: string,
  issues: IssueList,
  codec: ValueCodec,
): Milestone | undefined {
  reportUnknownKeys(record, path, issues, MILESTONE_KEYS);
  const milestone = { kind: 'milestone' as const, ...readDatedFields(record, path, issues, codec) };
  const { progressPercent } = milestone;
  if (progressPercent !== undefined && progressPercent !== 0 && progressPercent !== FULL_PROGRESS) {
    issues.add(`${path}.progressPercent`, 'OUT_OF_RANGE');
    return undefined;
  }
  return allDefined(milestone) ? milestone : undefined;
}

/** Reads a work task with its blocks and daily working pattern. */
function readWorkTask(
  record: UnknownRecord,
  path: string,
  issues: IssueList,
  codec: ValueCodec,
): WorkTask | undefined {
  reportUnknownKeys(record, path, issues, WORK_TASK_KEYS);
  const child = (key: string): Field => childField(record, key, path);
  const readHoursPerDay = (item: Field, list: IssueList): number | undefined =>
    readInteger(item, list, 1, HOURS_PER_DAY);
  const readDailyStart = (item: Field, list: IssueList): number | undefined =>
    readInteger(item, list, 0, LAST_HOUR_OF_DAY);
  const task = {
    kind: 'task' as const,
    ...readDatedFields(record, path, issues, codec),
    segments: readSegments(child('segments'), issues),
    hoursPerDay: readNullable(child('hoursPerDay'), issues, readHoursPerDay),
    dailyStartHour: readNullable(child('dailyStartHour'), issues, readDailyStart),
  };
  return allDefined(task) ? task : undefined;
}

/** Reads the blocks of a task: at least one, no gap before the first, at least one whole day before each other, and a total duration within the limit. */
function readSegments(field: Field, issues: IssueList): TaskSegment[] | undefined {
  const segments = readList(field, issues, MAX_SEGMENTS_PER_TASK, (item, list, index) =>
    readSegment(item, list, index === 0),
  );
  if (segments === undefined) {
    return undefined;
  }
  if (segments.length === 0) {
    issues.add(field.path, 'EMPTY_LIST');
    return undefined;
  }
  if (totalDurationHours(segments) > MAX_TASK_DURATION_HOURS) {
    issues.add(field.path, 'OUT_OF_RANGE');
    return undefined;
  }
  return segments;
}

/** Adds up the durations of the blocks of a task. */
function totalDurationHours(segments: readonly TaskSegment[]): number {
  return segments.reduce((total, segment) => total + segment.durationHours, 0);
}

/** Reads one block of a task. */
function readSegment(field: Field, issues: IssueList, isFirst: boolean): TaskSegment | undefined {
  const record = readRecord(field, issues, SEGMENT_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const minimumGap = isFirst ? 0 : 1;
  const maximumGap = isFirst ? 0 : MAX_SEGMENT_GAP_DAYS;
  const segment = {
    durationHours: readInteger(
      childField(record, 'durationHours', field.path),
      issues,
      1,
      MAX_TASK_DURATION_HOURS,
    ),
    gapDaysBefore: readInteger(
      childField(record, 'gapDaysBefore', field.path),
      issues,
      minimumGap,
      maximumGap,
    ),
  };
  return allDefined(segment) ? segment : undefined;
}

/** Reads one dependency between two tasks. */
function readDependency(field: Field, issues: IssueList): Dependency | undefined {
  const record = readRecord(field, issues, DEPENDENCY_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const dependency = {
    id: readIdentifier(child('id'), issues),
    predecessorId: readIdentifier(child('predecessorId'), issues),
    successorId: readIdentifier(child('successorId'), issues),
    type: readEnum(child('type'), issues, DEPENDENCY_TYPES),
    lagHours: readInteger(child('lagHours'), issues, -MAX_LAG_HOURS, MAX_LAG_HOURS),
  };
  return allDefined(dependency) ? dependency : undefined;
}

/** Reads a baseline plan: when it was taken and the frozen dates of each task, at most once per task. */
function readBaseline(field: Field, issues: IssueList, codec: ValueCodec): Baseline | undefined {
  const record = readRecord(field, issues, BASELINE_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const entriesField = childField(record, 'entries', field.path);
  const baseline = {
    takenAt: codec.readInstant(childField(record, 'takenAt', field.path), issues),
    entries: readList(entriesField, issues, MAX_TASKS, (item, list) =>
      readBaselineEntry(item, list, codec),
    ),
  };
  if (baseline.entries !== undefined) {
    reportDuplicateBaselineTasks(baseline.entries, entriesField.path, issues);
  }
  return allDefined(baseline) ? baseline : undefined;
}

/** Reads the frozen start, end and duration of one task, the end never coming before the start. */
function readBaselineEntry(
  field: Field,
  issues: IssueList,
  codec: ValueCodec,
): BaselineEntry | undefined {
  const record = readRecord(field, issues, BASELINE_ENTRY_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const child = (key: string): Field => childField(record, key, field.path);
  const entry = {
    taskId: readIdentifier(child('taskId'), issues),
    start: codec.readInstant(child('start'), issues),
    end: codec.readInstant(child('end'), issues),
    durationHours: readInteger(child('durationHours'), issues, 0, MAX_BASELINE_DURATION_HOURS),
  };
  if (entry.start !== undefined && entry.end !== undefined && entry.end < entry.start) {
    issues.add(`${field.path}.end`, 'OUT_OF_RANGE');
    return undefined;
  }
  return allDefined(entry) ? entry : undefined;
}

/** Reports every baseline entry whose task already has an earlier entry. */
function reportDuplicateBaselineTasks(
  entries: readonly BaselineEntry[],
  path: string,
  issues: IssueList,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.taskId)) {
      issues.add(`${path}[${String(index)}]`, 'DUPLICATE_ENTRY');
    }
    seen.add(entry.taskId);
  });
}

/** Reads every item of a list, holes included, returning nothing when one of them is invalid. */
function readList<T>(
  field: Field,
  issues: IssueList,
  maxItems: number,
  readItem: (item: Field, issues: IssueList, index: number) => T | undefined,
): T[] | undefined {
  const items = readArray(field, issues, maxItems);
  if (items === undefined) {
    return undefined;
  }
  const values = Array.from({ length: items.length }, (_unused, index) =>
    readItem(itemField(items, index, field.path), issues, index),
  );
  return values.every((value) => value !== undefined) ? values : undefined;
}

/** Tells whether every property of a freshly read object is valid, narrowing its type. */
function allDefined<T extends object>(
  value: T,
): value is { [Key in keyof T]: Exclude<T[Key], undefined> } {
  return Object.values(value).every((property) => property !== undefined);
}

/** Adds the calendar, daily pattern and structure problems that can only be checked once every field has been read. */
function reportSemanticIssues(project: Project, issues: IssueList, rootPath: string): void {
  const prefix = rootPath === '' ? '' : `${rootPath}.`;
  const calendar = compileCalendar(project.calendar);
  if (calendar.ok) {
    reportDailyWindowIssues(project.tasks, calendar.value, issues, prefix);
  } else {
    calendar.error.forEach((error) => {
      issues.add(`${prefix}${calendarPath(error.code, error.index)}`, error.code);
    });
  }
  const structure = analyzeStructureWithinLimits(project);
  if (!structure.ok) {
    structure.error.forEach((error) => {
      issues.add(`${prefix}${error.list}[${String(error.index)}]`, error.code);
    });
  }
}

/** Reports every work task whose hours per day or daily start hour do not fit the project calendar. */
function reportDailyWindowIssues(
  tasks: readonly Task[],
  calendar: CompiledCalendar,
  issues: IssueList,
  prefix: string,
): void {
  tasks.forEach((task, index) => {
    if (task.kind !== 'task') {
      return;
    }
    const window = computeDailyWindow(calendar, task);
    if (!window.ok) {
      const field = DAILY_WINDOW_FIELDS[window.error];
      issues.add(`${prefix}tasks[${String(index)}].${field}`, window.error);
    }
  });
}

/** Returns the location of a calendar problem inside the calendar. */
function calendarPath(code: CalendarErrorCode, index: number | undefined): string {
  const list = CALENDAR_ERROR_LISTS[code];
  return index === undefined ? `calendar.${list}` : `calendar.${list}[${String(index)}]`;
}
