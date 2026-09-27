import * as Y from 'yjs';
import type { Project } from '../model/project';
import { failure, success, type Result } from '../result';
import { readProject, readProjectShape, STORED_VALUE_CODEC } from '../validation/read-project';
import type { ValidationIssue } from '../validation/validation-issues';
import { repairProject, type Repair } from './repair-project';
import { readSharedData, writeSharedProject, type SharedProjectData } from './shared-document';

export const LOCAL_ORIGIN = Symbol('local change');
export const REMOTE_ORIGIN = Symbol('remote update');
export const REPAIR_ORIGIN = Symbol('merge repair');

export type SharedRepair =
  Repair | { readonly code: 'MILESTONE_PROGRESS_ROUNDED'; readonly id: string };

export type MergeFailure =
  | { readonly kind: 'malformedUpdate' }
  | { readonly kind: 'incompleteUpdate' }
  | { readonly kind: 'invalidProject'; readonly issues: readonly ValidationIssue[] };

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

/** Merges an untrusted update into a shared document, repairing the result, or leaves the document untouched when the update is malformed, still waits for earlier updates, or yields an invalid project. */
export function mergeSharedUpdate(
  document: Y.Doc,
  update: Uint8Array,
): Result<readonly SharedRepair[], MergeFailure> {
  const trial = new Y.Doc();
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(document));
  if (!applyUntrustedUpdate(trial, update)) {
    return failure({ kind: 'malformedUpdate' });
  }
  if (trial.store.pendingStructs !== null || trial.store.pendingDs !== null) {
    return failure({ kind: 'incompleteUpdate' });
  }
  const trialRepairs = repairSharedDocument(trial);
  if (!trialRepairs.ok) {
    return failure({ kind: 'invalidProject', issues: trialRepairs.error });
  }
  Y.applyUpdate(document, update, REMOTE_ORIGIN);
  const repairs = repairSharedDocument(document);
  return repairs.ok ? repairs : failure({ kind: 'invalidProject', issues: repairs.error });
}

/** Repairs the merged content of a shared document in place, or leaves it untouched when its fields are invalid. */
export function repairSharedDocument(
  document: Y.Doc,
): Result<readonly SharedRepair[], readonly ValidationIssue[]> {
  const rounded = roundMilestoneProgress(readSharedData(document));
  const shape = readProjectShape(rounded.data, STORED_VALUE_CODEC);
  if (!shape.ok) {
    return shape;
  }
  const repaired = repairProject(shape.value);
  const valid = readProject(repaired.project, STORED_VALUE_CODEC);
  if (!valid.ok) {
    return valid;
  }
  writeSharedProject(document, valid.value, REPAIR_ORIGIN);
  return success([...rounded.repairs, ...repaired.repairs]);
}

/** Applies an update received from another participant, telling whether it could be decoded. */
function applyUntrustedUpdate(document: Y.Doc, update: Uint8Array): boolean {
  try {
    Y.applyUpdate(document, update);
    return true;
  } catch {
    return false;
  }
}

/** Rounds to 0 or 100 the progress of milestones that took the progress of a work task during a merge. */
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
