import * as Y from 'yjs';
import { compileCalendar } from '../calendar/compile-calendar';
import { compareStrings } from '../compare-strings';
import { MAX_DEPENDENCIES, MAX_TAGS, MAX_TASKS } from '../limits';
import type { Dependency, Project, Tag, Task, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { readProject, STORED_VALUE_CODEC } from '../validation/read-project';
import type { ValidationIssue, ValidationIssues } from '../validation/validation-issues';
import {
  createProjectState,
  putDependency,
  putTag,
  putTask,
  removeDependency,
  removeTag,
  removeTask,
  toProject,
  type ProjectState,
} from './project-state';
import { fitDailyPattern } from './repair-project';
import {
  DEPENDENCIES_ROOT,
  deleteEntry,
  DOCUMENT_ID_KEY,
  findEntryIssues,
  findRootIssues,
  isCalendarField,
  LOCAL_ORIGIN,
  PROJECT_ROOT,
  readDocumentId,
  readEntry,
  readHeaderData,
  REMOTE_ORIGIN,
  REPAIR_ORIGIN,
  TAGS_ROOT,
  TASKS_ROOT,
  viewTaskFields,
  viewTaskUnion,
  writeEntry,
  writeProjectHeader,
  type DocumentId,
  type EntryRoot,
} from './shared-document';
import {
  applyToState,
  findDependencyProblem,
  findTaskProblem,
  readItemShape,
  withKnownTag,
  type SharedOperation,
  type TouchedItems,
} from './shared-operations';
import {
  DOCUMENT_ID_CHANGED,
  malformedUpdate,
  readSharedProject,
  repairDocumentProject,
  roundedProgress,
  type MergeFailure,
  type SharedRepair,
  type SharedRepairCode,
} from './shared-project';

export interface SharedSession {
  readonly document: Y.Doc;
  readonly documentId: DocumentId;
  readonly openingRepairs: readonly SharedRepair[];
  readonly project: () => Project;
  readonly apply: (operation: SharedOperation) => Result<void, ValidationIssues>;
  readonly applyAll: (operations: readonly SharedOperation[]) => Result<void, ValidationIssues>;
  readonly merge: (update: Uint8Array) => Result<readonly SharedRepair[], MergeFailure>;
  readonly history: SessionHistory;
}

export interface SessionHistory {
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  readonly undo: () => Result<readonly SharedRepair[], MergeFailure>;
  readonly redo: () => Result<readonly SharedRepair[], MergeFailure>;
}

interface SessionState {
  readonly documentId: DocumentId;
  state: ProjectState;
  shadow: Y.Doc;
  project: Project | null;
  stateChanged: boolean;
}

interface ShadowChange {
  readonly tasks: Set<TaskId>;
  readonly dependencies: Set<string>;
  readonly tags: Set<string>;
  readonly headerFields: Set<string>;
  structural: boolean;
}

interface ChangedItems {
  readonly tasks: readonly Task[];
  readonly dependencies: readonly Dependency[];
  readonly tags: readonly Tag[];
  readonly rounded: ReadonlySet<TaskId>;
  readonly deletedTasks: readonly TaskId[];
  readonly deletedDependencies: readonly string[];
  readonly deletedTags: readonly string[];
}

interface FastMerge {
  readonly repairs: readonly SharedRepair[];
  readonly writes: readonly Task[];
}

const FAST_REPAIR_ORDER: readonly SharedRepairCode[] = [
  'MILESTONE_PROGRESS_ROUNDED',
  'TAG_CLEARED',
  'HOURS_PER_DAY_REDUCED',
  'DAILY_START_HOUR_CLEARED',
];

export type StateOpeningFailure =
  | { readonly kind: 'unreadableState'; readonly error: unknown }
  | { readonly kind: 'invalidProject'; readonly issues: readonly ValidationIssue[] };

const INCOMPLETE_STATE = 'The state depends on updates it does not hold.';
const UNDO_CAPTURE_TIMEOUT_MS = 0;
const HISTORY_ROOTS = [PROJECT_ROOT, TASKS_ROOT, DEPENDENCIES_ROOT, TAGS_ROOT] as const;

type SharedType = Y.Transaction['changed'] extends Map<infer Type, unknown> ? Type : never;

/** Opens a session on a valid shared document, clearing and reporting references to missing tags, and keeps a validated, indexed copy of its project and a trial copy of the document. */
export function openSharedSession(
  document: Y.Doc,
): Result<SharedSession, readonly ValidationIssue[]> {
  return openSession(document, null);
}

/** Decodes a Yjs state into a new document and opens a session on it, the trial copy being decoded from the same state rather than from the document encoded again, refusing a state that cannot be read or that depends on updates it does not hold. */
export function openSharedSessionFromState(
  state: Uint8Array,
): Result<SharedSession, StateOpeningFailure> {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
  } catch (error) {
    return failure({ kind: 'unreadableState', error });
  }
  if (document.store.pendingStructs !== null || document.store.pendingDs !== null) {
    return failure({ kind: 'unreadableState', error: new Error(INCOMPLETE_STATE) });
  }
  const opened = openSession(document, state);
  return opened.ok ? opened : failure({ kind: 'invalidProject', issues: opened.error });
}

/** Opens a session on a valid shared document, its trial copy decoded from the state the document was just decoded from when one is given. */
function openSession(
  document: Y.Doc,
  decodedFrom: Uint8Array | null,
): Result<SharedSession, readonly ValidationIssue[]> {
  const documentId = readDocumentId(document);
  if (documentId === null) {
    return failure([{ path: DOCUMENT_ID_KEY, code: 'MISSING_FIELD' }]);
  }
  const read = readSharedProject(document);
  return read.ok ? success(validatedSession(document, read.value, documentId, decodedFrom)) : read;
}

/** Opens a session on a shared document whose project was already read and validated, so that it is not validated twice. */
export function openValidatedSession(
  document: Y.Doc,
  project: Project,
  documentId: DocumentId,
): SharedSession {
  return validatedSession(document, project, documentId, null);
}

/** Opens a session on a shared document whose project was validated, its trial copy decoded from the unchanged state the document was just decoded from when one is given and the opening cleared nothing, and copied from the document otherwise. */
function validatedSession(
  document: Y.Doc,
  project: Project,
  documentId: DocumentId,
  decodedFrom: Uint8Array | null,
): SharedSession {
  const tagIds = new Set(project.tags.map((tag) => tag.id));
  const tasks = project.tasks.map((task) => withKnownTag(task, (id) => tagIds.has(id)));
  const cleared = tasks.filter((task, index) => task !== project.tasks[index]);
  document.transact(() => {
    cleared.forEach((task) => {
      writeEntry(document, TASKS_ROOT, task);
    });
  }, REPAIR_ORIGIN);
  const opened = { ...project, tasks };
  const session: SessionState = {
    documentId,
    state: createProjectState(opened),
    shadow:
      decodedFrom === null || cleared.length > 0
        ? copyDocument(document, newRepairClientId(document))
        : documentFrom(decodedFrom, newRepairClientId(document)),
    project: opened,
    stateChanged: false,
  };
  document.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL_ORIGIN) {
      Y.applyUpdate(session.shadow, update);
    }
  });
  return {
    document,
    documentId,
    openingRepairs: cleared
      .map((task): SharedRepair => ({ code: 'TAG_CLEARED', id: task.id }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    project: () => currentProject(session),
    apply: (operation) => applyOperationToSession(session, document, operation),
    applyAll: (operations) => applyOperationsToSession(session, document, operations),
    merge: (update) => mergeIntoSession(session, document, update),
    history: createHistory(session, document),
  };
}

/** Keeps the local changes of a session in an undo history that ignores the changes of others, each undone or redone step being checked and repaired like a received update. */
function createHistory(session: SessionState, document: Y.Doc): SessionHistory {
  const roots = HISTORY_ROOTS.map((root) => document.getMap(root));
  const manager = new Y.UndoManager(roots, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });
  return {
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    undo: () =>
      replayStep(session, document, manager, {
        step: () => manager.undo(),
        revert: () => manager.redo(),
      }),
    redo: () =>
      replayStep(session, document, manager, {
        step: () => manager.redo(),
        revert: () => manager.undo(),
      }),
  };
}

/** Runs one step of the history on the document, then checks and repairs what it changed, reverting it when the project cannot be repaired. */
function replayStep(
  session: SessionState,
  document: Y.Doc,
  manager: Y.UndoManager,
  moves: { readonly step: () => unknown; readonly revert: () => unknown },
): Result<readonly SharedRepair[], MergeFailure> {
  const updates: Uint8Array[] = [];
  /** Keeps the updates the undo manager writes. */
  const collect = (update: Uint8Array, origin: unknown): void => {
    if (origin === manager) {
      updates.push(update);
    }
  };
  document.on('update', collect);
  moves.step();
  document.off('update', collect);
  if (updates.length === 0) {
    return success([]);
  }
  const repairUpdates: Uint8Array[] = [];
  const replayed = tryMerge(session, Y.mergeUpdates(updates), repairUpdates);
  if (!replayed.ok) {
    moves.revert();
    session.shadow = copyDocument(document, session.shadow.clientID);
    session.stateChanged = true;
    restoreState(session, document);
    session.project = null;
    return replayed;
  }
  session.stateChanged = false;
  if (repairUpdates.length > 0) {
    Y.applyUpdate(document, Y.mergeUpdates(repairUpdates), REPAIR_ORIGIN);
  }
  session.project = null;
  return replayed;
}

/** Returns the project of a session, rebuilt from the indexed state only after it changed. */
function currentProject(session: SessionState): Project {
  session.project ??= toProject(session.state);
  return session.project;
}

/** Checks an operation on the indexed state and writes only what it touched to the document, the state matching the document again when the check or the write raises. */
function applyOperationToSession(
  session: SessionState,
  document: Y.Doc,
  operation: SharedOperation,
): Result<void, ValidationIssues> {
  try {
    const checked = applyToState(session.state, operation);
    if (!checked.ok) {
      return checked;
    }
    session.project = null;
    document.transact(() => {
      writeTouched(document, session.state, checked.value);
    }, LOCAL_ORIGIN);
    return success(undefined);
  } catch (error) {
    throwAfterReset(session, document, error);
  }
}

/** Checks operations one after another on the indexed state and writes all they touched in one change, or nothing at all when one of them is refused or raises before the writing, the state matching the document again whenever something raises. */
function applyOperationsToSession(
  session: SessionState,
  document: Y.Doc,
  operations: readonly SharedOperation[],
): Result<void, ValidationIssues> {
  let written: Result<void, ValidationIssues>;
  try {
    written = writeOperations(session, document, operations);
  } catch (error) {
    throwAfterReset(session, document, error);
  }
  if (!written.ok) {
    resetState(session, document);
  }
  return written;
}

/** Puts the indexed state back as the document holds it after a change raised, then raises that error again, or both errors together when the document no longer holds a valid project either. */
function throwAfterReset(session: SessionState, document: Y.Doc, error: unknown): never {
  try {
    resetState(session, document);
  } catch (resetError) {
    throw new AggregateError(
      [error, resetError],
      'A change to the session failed, and its document could not be read back.',
    );
  }
  throw error;
}

/** Applies operations to the indexed state, then writes what they touched to the document, stopping at the first one refused, the state then still holding the operations checked before it. */
function writeOperations(
  session: SessionState,
  document: Y.Doc,
  operations: readonly SharedOperation[],
): Result<void, ValidationIssues> {
  const all: TouchedItems = {
    tasks: new Set(),
    dependencies: new Set(),
    tags: new Set(),
    header: false,
  };
  for (const operation of operations) {
    const checked = applyToState(session.state, operation);
    if (!checked.ok) {
      return checked;
    }
    addTouched(all, checked.value);
  }
  session.project = null;
  document.transact(() => {
    writeTouched(document, session.state, all);
  }, LOCAL_ORIGIN);
  return success(undefined);
}

/** Rebuilds the indexed state from the document after a change was refused or failed partway. */
function resetState(session: SessionState, document: Y.Doc): void {
  session.stateChanged = true;
  restoreState(session, document);
  session.project = null;
}

/** Adds the items one operation touched to those of the previous ones. */
function addTouched(all: TouchedItems, more: TouchedItems): void {
  more.tasks.forEach((id) => all.tasks.add(id));
  more.dependencies.forEach((id) => all.dependencies.add(id));
  more.tags.forEach((id) => all.tags.add(id));
  all.header ||= more.header;
}

/** Writes the touched project fields, tasks, dependencies and tags of the state to a document, deleting those that no longer exist. */
function writeTouched(document: Y.Doc, state: ProjectState, touched: TouchedItems): void {
  if (touched.header) {
    writeProjectHeader(document, state.header);
  }
  writeItems(document, TASKS_ROOT, touched.tasks, state.tasks);
  writeItems(document, DEPENDENCIES_ROOT, touched.dependencies, state.dependencies);
  writeItems(document, TAGS_ROOT, touched.tags, state.tags);
}

/** Writes the listed items that exist and deletes the others. */
function writeItems(
  document: Y.Doc,
  root: EntryRoot,
  ids: ReadonlySet<string>,
  items: ReadonlyMap<string, { readonly id: string }>,
): void {
  for (const id of ids) {
    const item = items.get(id);
    if (item === undefined) {
      deleteEntry(document, root, id);
    } else {
      writeEntry(document, root, item);
    }
  }
}

/** Merges an untrusted update: applied to the trial copy, checked and repaired only where it changed things, then applied with its repairs to the document. */
function mergeIntoSession(
  session: SessionState,
  document: Y.Doc,
  update: Uint8Array,
): Result<readonly SharedRepair[], MergeFailure> {
  const repairUpdates: Uint8Array[] = [];
  const merged = tryMerge(session, update, repairUpdates);
  if (!merged.ok) {
    session.shadow = copyDocument(document, session.shadow.clientID);
    restoreState(session, document);
    return merged;
  }
  session.stateChanged = false;
  Y.applyUpdate(document, Y.mergeUpdates([update, ...repairUpdates]), REMOTE_ORIGIN);
  session.project = null;
  return merged;
}

/** Applies an update to the trial copy and checks and repairs it, collecting the repairs written there, an exception raised by the bytes being a malformed update, and one raised during the repair a failed repair. */
function tryMerge(
  session: SessionState,
  update: Uint8Array,
  repairUpdates: Uint8Array[],
): Result<readonly SharedRepair[], MergeFailure> {
  const { shadow } = session;
  let change: ShadowChange;
  try {
    change = applyToShadow(shadow, update);
  } catch (error) {
    return malformedUpdate(error);
  }
  if (shadow.store.pendingStructs !== null || shadow.store.pendingDs !== null) {
    return failure({ kind: 'incompleteUpdate' });
  }
  if (readDocumentId(shadow) !== session.documentId) {
    return failure({ kind: 'invalidProject', issues: [DOCUMENT_ID_CHANGED] });
  }
  /** Keeps the updates a repair writes. */
  const collect = (repairUpdate: Uint8Array): void => {
    repairUpdates.push(repairUpdate);
  };
  shadow.on('update', collect);
  try {
    const repairs = change.structural ? repairAll(session) : repairChanged(session, change);
    return repairs.ok ? repairs : failure({ kind: 'invalidProject', issues: repairs.error });
  } catch (error) {
    return failure({ kind: 'repairFailed', error });
  } finally {
    shadow.off('update', collect);
  }
}

/** Applies an update to the trial copy and lists which project fields and entries it changed. */
function applyToShadow(shadow: Y.Doc, update: Uint8Array): ShadowChange {
  const change: ShadowChange = {
    tasks: new Set(),
    dependencies: new Set(),
    tags: new Set(),
    headerFields: new Set(),
    structural: false,
  };
  /** Notes in the indexed state every part of the document a transaction changed. */
  const collect = (transaction: Y.Transaction): void => {
    transaction.changed.forEach((keys, type) => {
      noteChange(shadow, change, type, keys);
    });
  };
  shadow.on('afterTransaction', collect);
  try {
    Y.applyUpdate(shadow, update, REMOTE_ORIGIN);
  } finally {
    shadow.off('afterTransaction', collect);
  }
  return change;
}

/** Records one changed shared type: a project field, an added or deleted entry, or fields of an entry. */
function noteChange(
  shadow: Y.Doc,
  change: ShadowChange,
  type: SharedType,
  keys: Set<string | null>,
): void {
  const names = [...keys].filter((key) => key !== null);
  if (Object.is(type, shadow.getMap(PROJECT_ROOT))) {
    names.forEach((key) => change.headerFields.add(key));
    change.structural ||= names.some(isCalendarField);
    return;
  }
  const rootName = rootNameOf(shadow, type);
  if (rootName === null) {
    noteEntryChange(shadow, change, type);
    return;
  }
  names.forEach((id) => entrySet(change, rootName).add(id));
}

/** Records the entry whose fields changed, a change anywhere else making the whole document be checked. */
function noteEntryChange(shadow: Y.Doc, change: ShadowChange, type: SharedType): void {
  const parent = type._item?.parent;
  const id = type._item?.parentSub ?? null;
  const rootName = parent instanceof Y.AbstractType ? rootNameOf(shadow, parent) : null;
  if (rootName === null || id === null) {
    change.structural = true;
    return;
  }
  entrySet(change, rootName).add(id);
}

/** Returns the name of a root map of the shared document, or null for any other shared type. */
function rootNameOf(shadow: Y.Doc, type: unknown): EntryRoot | null {
  const roots: readonly EntryRoot[] = [TASKS_ROOT, DEPENDENCIES_ROOT, TAGS_ROOT];
  return roots.find((root) => Object.is(shadow.getMap(root), type)) ?? null;
}

/** Returns the set of changed identifiers kept for a root. */
function entrySet(change: ShadowChange, root: EntryRoot): Set<string> {
  if (root === TASKS_ROOT) {
    return change.tasks;
  }
  return root === DEPENDENCIES_ROOT ? change.dependencies : change.tags;
}

/** Repairs the whole trial copy, as for a calendar change or an anomaly, then rebuilds the indexed state from it. */
function repairAll(
  session: SessionState,
): Result<readonly SharedRepair[], readonly ValidationIssue[]> {
  const repaired = repairDocumentProject(session.shadow);
  if (!repaired.ok) {
    return repaired;
  }
  session.state = createProjectState(repaired.value.project);
  return success(repaired.value.repairs);
}

/** Checks and repairs only what an update changed, falling back to the whole repair as soon as the changes break a structural rule. */
function repairChanged(
  session: SessionState,
  change: ShadowChange,
): Result<readonly SharedRepair[], readonly ValidationIssue[]> {
  const { shadow } = session;
  const schemaIssues = [
    ...findRootIssues(shadow),
    ...entryIssues(shadow, TASKS_ROOT, change.tasks),
    ...entryIssues(shadow, DEPENDENCIES_ROOT, change.dependencies),
    ...entryIssues(shadow, TAGS_ROOT, change.tags),
  ];
  if (schemaIssues.length > 0) {
    return failure(schemaIssues);
  }
  const header =
    change.headerFields.size > 0 ? readChangedHeader(shadow) : success(session.state.header);
  if (!header.ok) {
    return header;
  }
  const items = readChangedItems(shadow, header.value, change);
  if (!items.ok) {
    return items;
  }
  session.stateChanged = true;
  const merged = applyChangedItems(session.state, header.value, items.value);
  if (merged === null) {
    return repairAll(session);
  }
  shadow.transact(() => {
    merged.writes.forEach((task) => {
      writeEntry(shadow, TASKS_ROOT, task);
    });
  }, REPAIR_ORIGIN);
  return success(sortRepairs(merged.repairs));
}

/** Lists what does not belong in the changed entries of a root. */
function entryIssues(
  shadow: Y.Doc,
  root: EntryRoot,
  ids: ReadonlySet<string>,
): readonly ValidationIssue[] {
  return [...ids].flatMap((id) => findEntryIssues(shadow, root, id));
}

/** Reads and validates the project fields of the trial copy. */
function readChangedHeader(
  shadow: Y.Doc,
): Result<ProjectState['header'], readonly ValidationIssue[]> {
  const read = readProject(readHeaderData(shadow), STORED_VALUE_CODEC);
  if (!read.ok) {
    return read;
  }
  const { name, startDate, calendar, options, baseline } = read.value;
  return success({ name, startDate, calendar, options, baseline });
}

/** Reads and validates the changed entries that still exist, hidden task fields included, and lists the deleted ones. */
function readChangedItems(
  shadow: Y.Doc,
  header: ProjectState['header'],
  change: ShadowChange,
): Result<ChangedItems, readonly ValidationIssue[]> {
  const tasks = splitDeleted(shadow, TASKS_ROOT, change.tasks);
  const dependencies = splitDeleted(shadow, DEPENDENCIES_ROOT, change.dependencies);
  const tags = splitDeleted(shadow, TAGS_ROOT, change.tags);
  const unions = readItemShape(header, { tasks: tasks.present.map(viewTaskUnion) });
  if (!unions.ok) {
    return unions;
  }
  const rounded = new Set<TaskId>();
  const visible = tasks.present.map(viewTaskFields).map((entry) => {
    const round = roundedProgress(entry);
    if (round !== null) {
      rounded.add(String(round['id']));
    }
    return round ?? entry;
  });
  const read = readItemShape(header, {
    tasks: visible,
    dependencies: dependencies.present,
    tags: tags.present,
  });
  if (!read.ok) {
    return read;
  }
  return success({
    tasks: read.value.tasks,
    dependencies: read.value.dependencies,
    tags: read.value.tags,
    rounded,
    deletedTasks: tasks.deleted,
    deletedDependencies: dependencies.deleted,
    deletedTags: tags.deleted,
  });
}

/** Separates the changed entries of a root that still exist from those that were deleted. */
function splitDeleted(
  shadow: Y.Doc,
  root: EntryRoot,
  ids: ReadonlySet<string>,
): { readonly present: unknown[]; readonly deleted: string[] } {
  const present: unknown[] = [];
  const deleted: string[] = [];
  for (const id of ids) {
    const entry = readEntry(shadow, root, id);
    if (entry === undefined) {
      deleted.push(id);
    } else {
      present.push(entry);
    }
  }
  return { present, deleted };
}

/** Applies the changed items to the indexed state with the per-task repairs, or returns null when a structural rule is broken and the whole repair is needed. */
function applyChangedItems(
  state: ProjectState,
  header: ProjectState['header'],
  items: ChangedItems,
): FastMerge | null {
  state.header = header;
  items.deletedTags.forEach((id) => {
    removeTag(state, id);
  });
  items.tags.forEach((tag) => {
    putTag(state, tag);
  });
  [...items.deletedDependencies, ...items.dependencies.map((item) => item.id)].forEach((id) => {
    removeDependency(state, id);
  });
  items.deletedTasks.forEach((id) => {
    removeTask(state, id);
  });
  const fixed = fixTasks(
    state,
    [...items.tasks, ...untouchedTasksOfTags(state, items)],
    items.rounded,
  );
  const previous = new Map(fixed.tasks.map((task) => [task.id, state.tasks.get(task.id)]));
  fixed.tasks.forEach((task) => {
    putTask(state, task);
  });
  const broken =
    state.tags.size > MAX_TAGS ||
    state.tasks.size > MAX_TASKS ||
    hasOrphans(state, items.deletedTasks) ||
    fixed.tasks.some((task) => findTaskProblem(state, task, previous.get(task.id)) !== null);
  return broken || !addDependencies(state, items.dependencies) ? null : fixed;
}

/** Lists the tasks not changed by an update that point at a tag it deleted. */
function untouchedTasksOfTags(state: ProjectState, items: ChangedItems): Task[] {
  const changed = new Set(items.tasks.map((task) => task.id));
  return items.deletedTags
    .flatMap((id) => [...(state.tasksByTag.get(id) ?? [])])
    .filter((id) => !changed.has(id))
    .flatMap((id) => {
      const task = state.tasks.get(id);
      return task === undefined ? [] : [task];
    });
}

/** Clears missing tags and fits daily patterns, as the whole repair would for these tasks, noting the repairs and the tasks to write back. */
function fixTasks(
  state: ProjectState,
  tasks: readonly Task[],
  rounded: ReadonlySet<TaskId>,
): FastMerge & { readonly tasks: readonly Task[] } {
  const calendar = compileCalendar(state.header.calendar);
  const repairs: SharedRepair[] = [...rounded].map((id) => ({
    code: 'MILESTONE_PROGRESS_ROUNDED',
    id,
  }));
  const writes: Task[] = [];
  const fixed = tasks.map((task) => {
    const cleared = withKnownTag(task, (id) => state.tags.has(id));
    const fitted =
      cleared.kind === 'task' && calendar.ok
        ? fitDailyPattern(cleared, calendar.value)
        : { task: cleared, repairs: [] };
    repairs.push(...(cleared === task ? [] : [{ code: 'TAG_CLEARED' as const, id: task.id }]));
    repairs.push(...fitted.repairs);
    if (fitted.task !== task || rounded.has(task.id)) {
      writes.push(fitted.task);
    }
    return fitted.task;
  });
  return { repairs, writes, tasks: fixed };
}

/** Tells whether a deleted task still has children or dependencies. */
function hasOrphans(state: ProjectState, deletedTasks: readonly TaskId[]): boolean {
  return deletedTasks.some(
    (id) => (state.children.get(id)?.size ?? 0) > 0 || (state.links.get(id)?.size ?? 0) > 0,
  );
}

/** Adds dependencies one by one while each one keeps the network valid, telling whether all of them could be added. */
function addDependencies(state: ProjectState, dependencies: readonly Dependency[]): boolean {
  for (const dependency of dependencies) {
    if (findDependencyProblem(state, dependency) !== null) {
      return false;
    }
    putDependency(state, dependency);
  }
  return state.dependencies.size <= MAX_DEPENDENCIES;
}

/** Rebuilds the indexed state from a document after a refused or failed change left it half changed, throwing when the document no longer holds a valid project. */
function restoreState(session: SessionState, document: Y.Doc): void {
  if (!session.stateChanged) {
    return;
  }
  const read = readSharedProject(document);
  if (!read.ok) {
    throw new Error('The shared document of the session no longer holds a valid project.');
  }
  session.state = createProjectState(read.value);
  session.stateChanged = false;
}

/** Orders repairs as the full repair does: by kind of repair, then by identifier. */
function sortRepairs(repairs: readonly SharedRepair[]): SharedRepair[] {
  return [...repairs].sort(
    (left, right) =>
      FAST_REPAIR_ORDER.indexOf(left.code) - FAST_REPAIR_ORDER.indexOf(right.code) ||
      compareStrings(left.id, right.id),
  );
}

/** Copies a document into a new one that writes under a given identity. */
function copyDocument(document: Y.Doc, clientId: number): Y.Doc {
  return documentFrom(Y.encodeStateAsUpdate(document), clientId);
}

/** Decodes a Yjs state into a new document that writes under a given identity. */
function documentFrom(state: Uint8Array, clientId: number): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, state);
  copy.clientID = clientId;
  return copy;
}

/** Draws an identity for the repairs of a document, different from its own. */
function newRepairClientId(document: Y.Doc): number {
  let candidate = new Y.Doc().clientID;
  while (candidate === document.clientID) {
    candidate = new Y.Doc().clientID;
  }
  return candidate;
}
