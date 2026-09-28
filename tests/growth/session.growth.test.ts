import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Project } from '../../src/core/model/project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../src/core/shared/shared-session';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  batched,
  BATCH_SIZE,
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  MEASURED_RUNS,
  SMALL_TASK_COUNT,
} from './measure-growth';

const WARM_UP_RUNS = 1;
const EDITS_NEEDED = (MEASURED_RUNS + WARM_UP_RUNS) * BATCH_SIZE;

/** Opens a session on a copy of a shared document, failing the test when it cannot be opened. */
function openCopy(document: Y.Doc): SharedSession {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}

/** Returns a function that renames the task at a position of a session's initial project, a typical small edit measured without rebuilding the project list. */
function taskRenamer(session: SharedSession): (index: number) => void {
  const tasks = session.project().tasks;
  return (index) => {
    const task = tasks[index % tasks.length];
    if (task !== undefined) {
      session.apply({ type: 'putTask', task: { ...task, name: `Edit ${String(index)}` } });
    }
  };
}

/** Records the small updates a remote participant sends while editing, as the network would carry them. */
function recordRemoteEdits(document: Y.Doc): Uint8Array[] {
  const remote = openCopy(document);
  const updates: Uint8Array[] = [];
  remote.document.on('update', (update: Uint8Array) => {
    updates.push(update);
  });
  const rename = taskRenamer(remote);
  for (let index = 0; index < EDITS_NEEDED; index += 1) {
    rename(index);
  }
  return updates;
}

/** Builds a shared document holding the large project with a given number of tasks. */
function sharedProject(taskCount: number): Y.Doc {
  const project: Project = buildLargeProject(LARGE_PROJECT_SEED, taskCount);
  return createSharedDocument(project);
}

describe('growth of shared session operations with the size of the project', () => {
  const smallDocument = sharedProject(SMALL_TASK_COUNT);
  const largeDocument = sharedProject(LARGE_TASK_COUNT);

  it('applies a local edit in a time that does not depend on the size of the project', () => {
    const small = openCopy(smallDocument);
    const large = openCopy(largeDocument);
    const ratio = growthRatio(
      batched(BATCH_SIZE, taskRenamer(small)),
      batched(BATCH_SIZE, taskRenamer(large)),
    );
    console.info(`Local edit: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });

  it('merges a received edit in a time that does not depend on the size of the project', () => {
    const smallUpdates = recordRemoteEdits(smallDocument);
    const largeUpdates = recordRemoteEdits(largeDocument);
    const small = openCopy(smallDocument);
    const large = openCopy(largeDocument);
    const merge = (session: SharedSession, updates: readonly Uint8Array[]) =>
      batched(BATCH_SIZE, (index) => {
        const merged = session.merge(updates[index] ?? new Uint8Array());
        expect(merged.ok).toBe(true);
      });
    const ratio = growthRatio(merge(small, smallUpdates), merge(large, largeUpdates));
    console.info(`Received edit: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});
