import * as Y from 'yjs';
import { compareStrings } from '../compare-strings';
import type { Project } from '../model/project';
import { TASK_KEYS_BY_KIND } from '../validation/read-project';

export const PROJECT_ROOT = 'project';
export const TASKS_ROOT = 'tasks';
export const DEPENDENCIES_ROOT = 'dependencies';
export const TAGS_ROOT = 'tags';

const NEW_TASK_DURATION_HOURS = 1;
const HIDDEN_TASK_DEFAULTS: Readonly<Record<string, unknown>> = {
  progressPercent: 0,
  tagId: null,
  startNoEarlierThan: null,
  mustFinishOn: null,
  deadline: null,
  segments: [{ durationHours: NEW_TASK_DURATION_HOURS, gapDaysBefore: 0 }],
  hoursPerDay: null,
  dailyStartHour: null,
};

export interface SharedProjectData {
  readonly name: unknown;
  readonly startDate: unknown;
  readonly calendar: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly baseline: unknown;
  readonly tasks: readonly unknown[];
  readonly dependencies: readonly unknown[];
  readonly tags: readonly unknown[];
}

type Entry = Readonly<Record<string, unknown>>;

/** Creates a shared document holding a project. */
export function createSharedDocument(project: Project): Y.Doc {
  const document = new Y.Doc();
  writeSharedProject(document, project, null);
  return document;
}

/** Reads the raw content of a shared document as plain, still untrusted project data, lists sorted by identifier. */
export function readSharedData(document: Y.Doc): SharedProjectData {
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
    tasks: readEntries(document.getMap(TASKS_ROOT)).map(keepFieldsOfKind),
    dependencies: readEntries(document.getMap(DEPENDENCIES_ROOT)),
    tags: readEntries(document.getMap(TAGS_ROOT)),
  };
}

/** Writes a project into a shared document in one transaction, changing only what differs. */
export function writeSharedProject(document: Y.Doc, project: Project, origin: unknown): void {
  document.transact(() => {
    const root = document.getMap(PROJECT_ROOT);
    const { calendar, options } = project;
    const fields: Entry = {
      name: project.name,
      startDate: project.startDate,
      workingWeekdays: calendar.workingWeekdays,
      workingTimeRanges: calendar.workingTimeRanges,
      nonWorkingPeriods: calendar.nonWorkingPeriods,
      criticalPathEnabled: options.criticalPathEnabled,
      dateConstraintsEnabled: options.dateConstraintsEnabled,
      alwaysShowPatterns: options.alwaysShowPatterns,
      baseline: project.baseline,
    };
    setChangedFields(root, fields);
    writeEntries(document.getMap(TASKS_ROOT), project.tasks, HIDDEN_TASK_DEFAULTS);
    writeEntries(document.getMap(DEPENDENCIES_ROOT), project.dependencies, {});
    writeEntries(document.getMap(TAGS_ROOT), project.tags, {});
  }, origin);
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
  const record = entry as Entry;
  const kind = record['kind'];
  const keys =
    kind === 'summary' || kind === 'milestone' || kind === 'task' ? TASK_KEYS_BY_KIND[kind] : null;
  return keys === null ? record : Object.fromEntries(keys.map((key) => [key, record[key]]));
}

/** Writes a list of items into a shared map keyed by identifier, filling the hidden fields of new entries with defaults. */
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

/** Sets every field of a shared map whose stored value differs from the given one. */
function setChangedFields(map: Y.Map<unknown>, fields: object): void {
  const values: [string, unknown][] = Object.entries(fields);
  for (const [key, value] of values) {
    if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
      map.set(key, value);
    }
  }
}
