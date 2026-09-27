import * as Y from 'yjs';
import { MERGE_LIST_LIMIT_FACTOR } from '../limits';
import type { Project } from '../model/project';
import { failure, success, type Result } from '../result';
import {
  NOMINAL_LIST_LIMITS,
  readProject,
  readProjectShape,
  STORED_VALUE_CODEC,
  type ListLimits,
} from '../validation/read-project';
import type { ValidationIssue } from '../validation/validation-issues';
import { repairProject, type RepairCode } from './repair-project';
import {
  findSchemaIssues,
  LOCAL_ORIGIN,
  readSharedData,
  readSharedTaskUnions,
  REMOTE_ORIGIN,
  REPAIR_ORIGIN,
  writeSharedProject,
  type SharedProjectData,
} from './shared-document';

export type SharedRepairCode = RepairCode | 'MILESTONE_PROGRESS_ROUNDED';

export interface SharedRepair {
  readonly code: SharedRepairCode;
  readonly id: string;
}

export type MergeFailure =
  | { readonly kind: 'malformedUpdate'; readonly reason: string }
  | { readonly kind: 'incompleteUpdate' }
  | { readonly kind: 'invalidProject'; readonly issues: readonly ValidationIssue[] };

interface TrialMerge {
  readonly repairs: readonly SharedRepair[];
  readonly mergedUpdate: Uint8Array;
}

const repairClientIds = new WeakMap<Y.Doc, number>();

const MERGE_LIST_LIMITS: ListLimits = {
  tasks: NOMINAL_LIST_LIMITS.tasks * MERGE_LIST_LIMIT_FACTOR,
  dependencies: NOMINAL_LIST_LIMITS.dependencies * MERGE_LIST_LIMIT_FACTOR,
  tags: NOMINAL_LIST_LIMITS.tags * MERGE_LIST_LIMIT_FACTOR,
};
const FULL_PROGRESS = 100;
const HALF_PROGRESS = 50;

/** Reads and fully validates the project held by a shared document. */
export function readSharedProject(document: Y.Doc): Result<Project, readonly ValidationIssue[]> {
  return readProject(readSharedData(document), STORED_VALUE_CODEC);
}

/** Applies a local change to the project of a shared document, writing it only when the changed project is valid. */
export function applySharedChange(
  document: Y.Doc,
  change: (project: Project) => Project,
): Result<Project, readonly ValidationIssue[]> {
  const current = readSharedProject(document);
  if (!current.ok) {
    return current;
  }
  const changed = readProject(change(current.value), STORED_VALUE_CODEC);
  if (changed.ok) {
    writeSharedProject(document, changed.value, LOCAL_ORIGIN);
  }
  return changed;
}

/** Merges an untrusted update into a shared document together with its repairs, in one transaction, after checking on a copy that the update is readable, complete and yields a valid project. */
export function mergeSharedUpdate(
  document: Y.Doc,
  update: Uint8Array,
): Result<readonly SharedRepair[], MergeFailure> {
  const trial = tryUpdate(document, update);
  if (!trial.ok) {
    return trial;
  }
  Y.applyUpdate(document, trial.value.mergedUpdate, REMOTE_ORIGIN);
  return success(trial.value.repairs);
}

/** Repairs the merged content of a shared document in place, or leaves it untouched when it cannot be made valid. */
export function repairSharedDocument(
  document: Y.Doc,
): Result<readonly SharedRepair[], readonly ValidationIssue[]> {
  const schemaIssues = findSchemaIssues(document);
  if (schemaIssues.length > 0) {
    return failure(schemaIssues);
  }
  const hiddenFields = readProjectShape(
    readSharedTaskUnions(document),
    STORED_VALUE_CODEC,
    MERGE_LIST_LIMITS,
  );
  if (!hiddenFields.ok) {
    return hiddenFields;
  }
  const rounded = roundMilestoneProgress(readSharedData(document));
  const shape = readProjectShape(rounded.data, STORED_VALUE_CODEC, MERGE_LIST_LIMITS);
  if (!shape.ok) {
    return shape;
  }
  const repaired = repairProject(shape.value);
  if (!repaired.ok) {
    return failure([{ path: '', code: repaired.error }]);
  }
  const valid = readProject(repaired.value.project, STORED_VALUE_CODEC);
  if (!valid.ok) {
    return valid;
  }
  writeSharedProject(document, valid.value, REPAIR_ORIGIN);
  return success([...rounded.repairs, ...repaired.value.repairs]);
}

/** Merges an update into a throwaway copy of a document and repairs it there under the document's repair identity, returning what the document is missing, and turning any exception raised by untrusted bytes into a failure. */
function tryUpdate(document: Y.Doc, update: Uint8Array): Result<TrialMerge, MergeFailure> {
  const trial = new Y.Doc();
  try {
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(trial, update);
    if (trial.store.pendingStructs !== null || trial.store.pendingDs !== null) {
      return failure({ kind: 'incompleteUpdate' });
    }
    trial.clientID = repairClientId(document);
    const repairs = repairSharedDocument(trial);
    if (!repairs.ok) {
      return failure({ kind: 'invalidProject', issues: repairs.error });
    }
    const mergedUpdate = Y.encodeStateAsUpdate(trial, Y.encodeStateVector(document));
    return success({ repairs: repairs.value, mergedUpdate });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failure({ kind: 'malformedUpdate', reason });
  }
}

/** Returns the identity under which a document writes its merge repairs, stable for the document and different from its own, so that repairs can travel inside a received update. */
function repairClientId(document: Y.Doc): number {
  const known = repairClientIds.get(document);
  if (known !== undefined && known !== document.clientID) {
    return known;
  }
  let candidate = new Y.Doc().clientID;
  while (candidate === document.clientID) {
    candidate = new Y.Doc().clientID;
  }
  repairClientIds.set(document, candidate);
  return candidate;
}

/** Rounds to 0 or 100 the progress of every milestone whose progress is partial. */
function roundMilestoneProgress(data: SharedProjectData): {
  readonly data: SharedProjectData;
  readonly repairs: readonly SharedRepair[];
} {
  const repairs: SharedRepair[] = [];
  const tasks = data.tasks.map((task) => {
    const rounded = roundedProgress(task);
    if (rounded === null) {
      return task;
    }
    repairs.push({ code: 'MILESTONE_PROGRESS_ROUNDED', id: String(rounded['id']) });
    return rounded;
  });
  return { data: { ...data, tasks }, repairs };
}

/** Returns a milestone record with its progress rounded, or null when the record is not a milestone with a partial progress. */
function roundedProgress(
  task: unknown,
): (Readonly<Record<string, unknown>> & { readonly progressPercent: number }) | null {
  if (typeof task !== 'object' || task === null || !('kind' in task) || task.kind !== 'milestone') {
    return null;
  }
  const progress = 'progressPercent' in task ? task.progressPercent : undefined;
  if (!Number.isInteger(progress) || typeof progress !== 'number') {
    return null;
  }
  if (progress <= 0 || progress >= FULL_PROGRESS) {
    return null;
  }
  return { ...task, progressPercent: progress < HALF_PROGRESS ? 0 : FULL_PROGRESS };
}
