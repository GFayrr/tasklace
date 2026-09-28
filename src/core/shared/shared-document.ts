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

export type EntryRoot = typeof TASKS_ROOT | typeof DEPENDENCIES_ROOT | typeof TAGS_ROOT;

export type ProjectHeader = Omit<Project, 'tasks' | 'dependencies' | 'tags'>;

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
const ENTRY_KEYS_BY_ROOT: readonly (readonly [EntryRoot, readonly string[]])[] = [
  [TASKS_ROOT, WORK_TASK_KEYS.filter((key) => key !== 'id')],
  [DEPENDENCIES_ROOT, DEPENDENCY_KEYS.filter((key) => key !== 'id')],
  [TAGS_ROOT, TAG_KEYS.filter((key) => key !== 'id')],
];
const CALENDAR_FIELD_KEYS: readonly string[] = [
  'workingWeekdays',
  'workingTimeRanges',
  'nonWorkingPeriods',
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

/** Lists what does not belong at the top of a shared document: unknown roots, unknown or nested project fields and hidden list content. */
export function findRootIssues(document: Y.Doc): readonly ValidationIssue[] {
  const issues = createIssueList();
  for (const name of [...document.share.keys()].filter((root) => !ROOTS.includes(root))) {
    issues.add(name, 'UNKNOWN_FIELD');
  }
  checkFields(document.getMap(PROJECT_ROOT), PROJECT_ROOT, PROJECT_FIELD_KEYS, issues);
  for (const [root] of ENTRY_KEYS_BY_ROOT) {
    checkSequenceContent(document.getMap(root), root, issues);
  }
  return issues.issues;
}

/** Lists what does not belong in one entry of a shared document, a missing entry having nothing to report. */
export function findEntryIssues(
  document: Y.Doc,
  root: EntryRoot,
  id: string,
): readonly ValidationIssue[] {
  const issues = createIssueList();
  const entry = document.getMap(root).get(id);
  const allowedKeys = ENTRY_KEYS_BY_ROOT.find(([name]) => name === root)?.[1] ?? [];
  if (entry instanceof Y.Map) {
    checkFields(entry, `${root}.${id}`, allowedKeys, issues);
  } else if (entry !== undefined) {
    issues.add(`${root}.${id}`, 'WRONG_TYPE');
  }
  return issues.issues;
}

/** Reads one entry of a shared document as a plain record carrying its identifier, or undefined when it no longer exists. */
export function readEntry(document: Y.Doc, root: EntryRoot, id: string): unknown {
  const entry = document.getMap(root).get(id);
  return entry instanceof Y.Map ? { ...entry.toJSON(), id } : entry;
}

/** Reads the project fields of a shared document as plain, still untrusted data. */
export function readHeaderData(document: Y.Doc): SharedProjectData {
  return { ...readData(document, keepFieldsOfKind, false) };
}

/** Tells whether a project field of a shared document belongs to the calendar. */
export function isCalendarField(key: string): boolean {
  return CALENDAR_FIELD_KEYS.includes(key);
}

/** Keeps only the fields of the kind of a task, the others staying hidden in the shared document. */
export function viewTaskFields(entry: unknown): unknown {
  return keepFieldsOfKind(entry);
}

/** Presents a task entry with all its fields, hidden ones included, as a work task. */
export function viewTaskUnion(entry: unknown): unknown {
  return asWorkTask(entry);
}

/** Writes the project fields of a shared document, changing only what differs. */
export function writeProjectHeader(document: Y.Doc, header: ProjectHeader): void {
  setChangedFields(document.getMap(PROJECT_ROOT), headerFields(header));
}

/** Writes one task, dependency or tag into a shared document, filling the hidden fields of a new task with defaults. */
export function writeEntry(document: Y.Doc, root: EntryRoot, item: { readonly id: string }): void {
  writeItem(document.getMap(root), item, root === TASKS_ROOT ? HIDDEN_TASK_DEFAULTS : {});
}

/** Deletes one task, dependency or tag from a shared document. */
export function deleteEntry(document: Y.Doc, root: EntryRoot, id: string): void {
  document.getMap(root).delete(id);
}

/** Writes a project into a shared document in one transaction, changing only what differs. */
export function writeSharedProject(
  document: Y.Doc,
  project: Project,
  origin: SharedOrigin | null,
): void {
  document.transact(() => {
    writeProjectHeader(document, project);
    writeEntries(document.getMap(TASKS_ROOT), project.tasks, HIDDEN_TASK_DEFAULTS);
    writeEntries(document.getMap(DEPENDENCIES_ROOT), project.dependencies, {});
    writeEntries(document.getMap(TAGS_ROOT), project.tags, {});
  }, origin);
}

/** Lists the fields of the project root of a shared document for a project header. */
function headerFields(header: ProjectHeader): object {
  const { calendar, options } = header;
  return {
    name: header.name,
    startDate: header.startDate,
    workingWeekdays: calendar.workingWeekdays,
    workingTimeRanges: calendar.workingTimeRanges,
    nonWorkingPeriods: calendar.nonWorkingPeriods,
    criticalPathEnabled: options.criticalPathEnabled,
    dateConstraintsEnabled: options.dateConstraintsEnabled,
    alwaysShowPatterns: options.alwaysShowPatterns,
    baseline: header.baseline,
  };
}

/** Reads the raw content of a shared document, presenting each task entry through a given view, with or without its lists. */
function readData(
  document: Y.Doc,
  viewTask: (entry: unknown) => unknown,
  withLists = true,
): SharedProjectData {
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
    tasks: withLists ? readEntries(document.getMap(TASKS_ROOT)).map(viewTask) : [],
    dependencies: withLists ? readEntries(document.getMap(DEPENDENCIES_ROOT)) : [],
    tags: withLists ? readEntries(document.getMap(TAGS_ROOT)) : [],
  };
}

/** Reports every entry of a shared map that is not a map, then the fields of the others that do not belong in them. */
function checkEntries(
  entries: Y.Map<unknown>,
  root: string,
  allowedKeys: readonly string[],
  issues: IssueList,
): void {
  checkSequenceContent(entries, root, issues);
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
  checkSequenceContent(fields, path, issues);
  for (const [key, value] of fields.entries()) {
    if (!allowedKeys.includes(key)) {
      issues.add(`${path}.${key}`, 'UNKNOWN_FIELD');
    } else if (value instanceof Y.AbstractType) {
      issues.add(`${path}.${key}`, 'WRONG_TYPE');
    }
  }
}

/** Reports a shared map that also holds live list or text content, which the schema never allows and a map would hide. */
function checkSequenceContent(type: Y.Map<unknown>, path: string, issues: IssueList): void {
  for (let item = type._start; item !== null; item = item.right) {
    if (!item.deleted) {
      issues.add(path, 'WRONG_TYPE');
      return;
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
  for (const item of items) {
    writeItem(entries, item, hiddenDefaults);
  }
}

/** Writes one item into a shared map keyed by identifier, filling the hidden fields of a new entry with defaults. */
function writeItem(
  entries: Y.Map<unknown>,
  { id, ...fields }: { readonly id: string },
  hiddenDefaults: object,
): void {
  const existing = entries.get(id);
  const entry = existing instanceof Y.Map ? existing : new Y.Map<unknown>();
  if (entry !== existing) {
    entries.set(id, entry);
    setChangedFields(entry, hiddenDefaults);
  }
  setChangedFields(entry, fields);
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
