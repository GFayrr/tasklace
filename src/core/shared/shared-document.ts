import * as Y from 'yjs';
import { compareStrings } from '../compare-strings';
import type { Project, SummaryTask, WorkTask } from '../model/project';
import {
  DEPENDENCY_KEYS,
  TAG_KEYS,
  TASK_KEYS_BY_KIND,
  WORK_TASK_KEYS,
} from '../validation/read-project';
import {
  createIssueList,
  type IssueList,
  type ValidationIssue,
} from '../validation/validation-issues';

export const PROJECT_ROOT = 'project';
export const TASKS_ROOT = 'tasks';
export const DEPENDENCIES_ROOT = 'dependencies';
export const TAGS_ROOT = 'tags';

export const LOCAL_ORIGIN = Symbol('local change');
export const REMOTE_ORIGIN = Symbol('remote update');
export const REPAIR_ORIGIN = Symbol('merge repair');

export type SharedOrigin = typeof LOCAL_ORIGIN | typeof REMOTE_ORIGIN | typeof REPAIR_ORIGIN;

export type SharedProjectData = { readonly [Key in keyof Project]: unknown } & {
  readonly tasks: readonly unknown[];
};

const ROOTS: readonly string[] = [PROJECT_ROOT, TASKS_ROOT, DEPENDENCIES_ROOT, TAGS_ROOT];
const PROJECT_FIELD_KEYS: readonly string[] = [
  'name',
  'startDate',
  'workingWeekdays',
  'workingTimeRanges',
  'nonWorkingPeriods',
  'criticalPathEnabled',
  'dateConstraintsEnabled',
  'alwaysShowPatterns',
  'baseline',
];
const ENTRY_KEYS_BY_ROOT: readonly (readonly [string, readonly string[]])[] = [
  [TASKS_ROOT, WORK_TASK_KEYS.filter((key) => key !== 'id')],
  [DEPENDENCIES_ROOT, DEPENDENCY_KEYS.filter((key) => key !== 'id')],
  [TAGS_ROOT, TAG_KEYS.filter((key) => key !== 'id')],
];

const NEW_TASK_DURATION_HOURS = 1;
const HIDDEN_TASK_DEFAULTS: Omit<WorkTask, keyof SummaryTask> = {
  progressPercent: 0,
  tagId: null,
  startNoEarlierThan: null,
  mustFinishOn: null,
  deadline: null,
  segments: [{ durationHours: NEW_TASK_DURATION_HOURS, gapDaysBefore: 0 }],
  hoursPerDay: null,
  dailyStartHour: null,
};

/** Creates a shared document holding a project. */
export function createSharedDocument(project: Project): Y.Doc {
  const document = new Y.Doc();
  writeSharedProject(document, project, null);
  return document;
}

/** Reads the raw content of a shared document as plain, still untrusted project data, lists sorted by identifier and tasks limited to the fields of their kind. */
export function readSharedData(document: Y.Doc): SharedProjectData {
  return readData(document, keepFieldsOfKind);
}

/** Reads the raw content of a shared document with every task seen as a work task, so that the fields hidden by its kind can be validated too. */
export function readSharedTaskUnions(document: Y.Doc): SharedProjectData {
  return readData(document, asWorkTask);
}

/** Lists what does not belong in a shared document: unknown roots or fields, entries that are not maps and nested shared types. */
export function findSchemaIssues(document: Y.Doc): readonly ValidationIssue[] {
  const issues = createIssueList();
  for (const name of [...document.share.keys()].filter((root) => !ROOTS.includes(root))) {
    issues.add(name, 'UNKNOWN_FIELD');
  }
  checkFields(document.getMap(PROJECT_ROOT), PROJECT_ROOT, PROJECT_FIELD_KEYS, issues);
  for (const [root, allowedKeys] of ENTRY_KEYS_BY_ROOT) {
    checkEntries(document.getMap(root), root, allowedKeys, issues);
  }
  return issues.issues;
}

/** Writes a project into a shared document in one transaction, changing only what differs. */
export function writeSharedProject(
  document: Y.Doc,
  project: Project,
  origin: SharedOrigin | null,
): void {
  document.transact(() => {
    const { calendar, options } = project;
    setChangedFields(document.getMap(PROJECT_ROOT), {
      name: project.name,
      startDate: project.startDate,
      workingWeekdays: calendar.workingWeekdays,
      workingTimeRanges: calendar.workingTimeRanges,
      nonWorkingPeriods: calendar.nonWorkingPeriods,
      criticalPathEnabled: options.criticalPathEnabled,
      dateConstraintsEnabled: options.dateConstraintsEnabled,
      alwaysShowPatterns: options.alwaysShowPatterns,
      baseline: project.baseline,
    });
    writeEntries(document.getMap(TASKS_ROOT), project.tasks, HIDDEN_TASK_DEFAULTS);
    writeEntries(document.getMap(DEPENDENCIES_ROOT), project.dependencies, {});
    writeEntries(document.getMap(TAGS_ROOT), project.tags, {});
  }, origin);
}

/** Reads the raw content of a shared document, presenting each task entry through a given view. */
function readData(document: Y.Doc, viewTask: (entry: unknown) => unknown): SharedProjectData {
  const root = document.getMap(PROJECT_ROOT);
  return {
    name: root.get('name'),
    startDate: root.get('startDate'),
    calendar: {
      workingWeekdays: root.get('workingWeekdays'),
      workingTimeRanges: root.get('workingTimeRanges'),
      nonWorkingPeriods: root.get('nonWorkingPeriods'),
    },
    options: {
      criticalPathEnabled: root.get('criticalPathEnabled'),
      dateConstraintsEnabled: root.get('dateConstraintsEnabled'),
      alwaysShowPatterns: root.get('alwaysShowPatterns'),
    },
    baseline: root.get('baseline'),
    tasks: readEntries(document.getMap(TASKS_ROOT)).map(viewTask),
    dependencies: readEntries(document.getMap(DEPENDENCIES_ROOT)),
    tags: readEntries(document.getMap(TAGS_ROOT)),
  };
}

/** Reports every entry of a shared map that is not a map, then the fields of the others that do not belong in them. */
function checkEntries(
  entries: Y.Map<unknown>,
  root: string,
  allowedKeys: readonly string[],
  issues: IssueList,
): void {
  for (const [id, entry] of entries.entries()) {
    if (entry instanceof Y.Map) {
      checkFields(entry, `${root}.${id}`, allowedKeys, issues);
    } else {
      issues.add(`${root}.${id}`, 'WRONG_TYPE');
    }
  }
}

/** Reports every field of a shared map that is unknown or holds a nested shared type instead of a plain value. */
function checkFields(
  fields: Y.Map<unknown>,
  path: string,
  allowedKeys: readonly string[],
  issues: IssueList,
): void {
  for (const [key, value] of fields.entries()) {
    if (!allowedKeys.includes(key)) {
      issues.add(`${path}.${key}`, 'UNKNOWN_FIELD');
    } else if (value instanceof Y.AbstractType) {
      issues.add(`${path}.${key}`, 'WRONG_TYPE');
    }
  }
}

/** Lists the entries of a shared map as plain records carrying their identifier, sorted by identifier. */
function readEntries(entries: Y.Map<unknown>): unknown[] {
  return [...entries.keys()].sort(compareStrings).map((id) => {
    const entry = entries.get(id);
    return entry instanceof Y.Map ? { ...entry.toJSON(), id } : entry;
  });
}

/** Keeps only the fields of the kind of a task, the others staying hidden in the shared document. */
function keepFieldsOfKind(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const fields = new Map<string, unknown>(Object.entries(entry));
  const kind = fields.get('kind');
  if (kind !== 'summary' && kind !== 'milestone' && kind !== 'task') {
    return entry;
  }
  return Object.fromEntries(TASK_KEYS_BY_KIND[kind].map((key) => [key, fields.get(key)]));
}

/** Presents a task entry with all its fields, hidden ones included, as a work task. */
function asWorkTask(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null ? { ...entry, kind: 'task' } : entry;
}

/** Writes a list of items into a shared map keyed by identifier, deleting the entries no longer listed and filling the hidden fields of new entries with defaults. */
function writeEntries(
  entries: Y.Map<unknown>,
  items: readonly { readonly id: string }[],
  hiddenDefaults: object,
): void {
  const ids = new Set(items.map((item) => item.id));
  for (const id of [...entries.keys()].filter((key) => !ids.has(key))) {
    entries.delete(id);
  }
  for (const { id, ...fields } of items) {
    const existing = entries.get(id);
    const entry = existing instanceof Y.Map ? existing : new Y.Map<unknown>();
    if (entry !== existing) {
      entries.set(id, entry);
      setChangedFields(entry, hiddenDefaults);
    }
    setChangedFields(entry, fields);
  }
}

/** Sets every field of a shared map whose stored value differs from the given one or is a nested shared type. */
function setChangedFields(map: Y.Map<unknown>, fields: object): void {
  const values: [string, unknown][] = Object.entries(fields);
  for (const [key, value] of values) {
    const stored = map.get(key);
    if (stored instanceof Y.AbstractType || JSON.stringify(stored) !== JSON.stringify(value)) {
      map.set(key, value);
    }
  }
}
