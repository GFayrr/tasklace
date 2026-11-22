import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Project } from '../../src/core/model/project';
import { compareStrings } from '../../src/core/compare-strings';
import {
  createProjectState,
  projectAfterChanges,
  putTask,
  toProject,
} from '../../src/core/shared/project-state';
import { repairProject } from '../../src/core/shared/repair-project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import {
  openSharedSession,
  type SharedSession,
  sessionDocument,
} from '../../src/core/shared/shared-session';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  batched,
  BATCH_SIZE,
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  MEASURED_RUNS,
  SMALL_TASK_COUNT,
} from './measure-growth';
import {
  link,
  project,
  splitTask,
  TEST_DOCUMENT_ID,
  workTask,
  segmentsOrThrow,
  testId,
} from '../../src/core/testing/project-builder';

const WARM_UP_RUNS = 1;
const EDITS_NEEDED = (MEASURED_RUNS + WARM_UP_RUNS) * BATCH_SIZE;
const HUB_ID = 'hub';
const HUB_BLOCK_HOURS = 2;
const MIN_HUB_BLOCKS = 2;
const REBUILDS_PER_RUN = 10;

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
  sessionDocument(remote).on('update', (update: Uint8Array) => {
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
  return createSharedDocument(project, TEST_DOCUMENT_ID);
}

/** Builds a shared document where a split task leads to every other task, themselves chained one after the other. */
function hubProject(taskCount: number): Y.Doc {
  const hub = splitTask(HUB_ID, [
    [HUB_BLOCK_HOURS, 0],
    [HUB_BLOCK_HOURS, 0],
  ]);
  const others = Array.from({ length: taskCount }, (_unused, index) =>
    workTask(`t${String(index)}`),
  );
  const fromHub = others.map((task) => link(HUB_ID, task.id));
  const chain = others.slice(1).map((task, index) => link(others[index]?.id ?? '', task.id));
  return createSharedDocument(project([hub, ...others], [...fromHub, ...chain]), TEST_DOCUMENT_ID);
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

  it('changes the lag of a dependency in a time that does not depend on how much follows it', () => {
    /** Changes the lag of the link from the hub to the first task of the chain, which every task follows. */
    const lagChanger = (session: SharedSession) => {
      const first = session
        .project()
        .dependencies.find((dependency) => dependency.id === testId(`${HUB_ID}-t0`));
      if (first === undefined) {
        throw new Error('The hub does not lead to the first task.');
      }
      return (index: number) => {
        const changed = session.apply({
          type: 'putDependency',
          dependency: { ...first, lagHours: index % 2 },
        });
        expect(changed.ok).toBe(true);
      };
    };
    const small = openCopy(hubProject(SMALL_TASK_COUNT));
    const large = openCopy(hubProject(LARGE_TASK_COUNT));
    const ratio = growthRatio(
      batched(BATCH_SIZE, lagChanger(small)),
      batched(BATCH_SIZE, lagChanger(large)),
    );
    console.info(`Lag of a dependency: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });

  it('merges a received edit in a time that does not depend on the size of the project', () => {
    const smallUpdates = recordRemoteEdits(smallDocument);
    const largeUpdates = recordRemoteEdits(largeDocument);
    const small = openCopy(smallDocument);
    const large = openCopy(largeDocument);
    /** Merges the updates of a batch one by one. */
    const merge = (session: SharedSession, updates: readonly Uint8Array[]) =>
      batched(BATCH_SIZE, (index) => {
        const merged = session.merge(updates[index] ?? new Uint8Array());
        expect(merged.ok).toBe(true);
      });
    const ratio = growthRatio(merge(small, smallUpdates), merge(large, largeUpdates));
    console.info(`Received edit: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });

  it('rebuilds the project after as many new tasks as it holds in quasi-linear time', () => {
    /** Prepares an indexed state where a copy follows each task of a project sorted as the session sorts it, checks the rebuilt project once, then rebuilds it, the copies being noted as touched again before each rebuild. */
    const doubling = (taskCount: number) => {
      const built = buildLargeProject(LARGE_PROJECT_SEED, taskCount);
      const before = {
        ...built,
        tasks: [...built.tasks].sort((left, right) => compareStrings(left.id, right.id)),
        dependencies: [...built.dependencies].sort((left, right) =>
          compareStrings(left.id, right.id),
        ),
        tags: [...built.tags].sort((left, right) => compareStrings(left.id, right.id)),
      };
      const state = createProjectState(before);
      const copies = before.tasks.map((task) => ({ ...task, id: testId(`${task.id}-next`) }));
      copies.forEach((copy) => {
        putTask(state, copy);
      });
      expect(projectAfterChanges(state, before)).toEqual(toProject(state));
      return batched(REBUILDS_PER_RUN, () => {
        copies.forEach((copy) => state.touched.tasks.add(copy.id));
        expect(projectAfterChanges(state, before).tasks).toHaveLength(taskCount * 2);
      });
    };
    const ratio = growthRatio(doubling(SMALL_TASK_COUNT), doubling(LARGE_TASK_COUNT));
    console.info(`Project after doubling: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('changes the number of blocks of a task linked to every other task in linear time', () => {
    /** Prepares a project whose hub task changes its number of blocks at each run. */
    const resplitter = (taskCount: number) => {
      const session = openCopy(hubProject(taskCount));
      const hub = session.project().tasks.find((task) => task.id === HUB_ID);
      if (hub?.kind !== 'task') {
        throw new Error('Missing hub task');
      }
      return batched(1, (index) => {
        const blockCount = MIN_HUB_BLOCKS + (index % 2);
        const segments = segmentsOrThrow(
          Array.from({ length: blockCount }, () => ({
            durationHours: HUB_BLOCK_HOURS,
            gapDaysBefore: 0,
            startNoEarlierThan: null,
          })),
        );
        expect(session.apply({ type: 'putTask', task: { ...hub, segments } }).ok).toBe(true);
      });
    };
    const ratio = growthRatio(resplitter(SMALL_TASK_COUNT), resplitter(LARGE_TASK_COUNT));
    console.info(`Change the blocks of a linked task: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('undoes a local edit in a time that does not depend on the size of the project', () => {
    /** Prepares a session with enough changes to undo at each run. */
    const undoer = (document: Y.Doc) => {
      const session = openCopy(document);
      const rename = taskRenamer(session);
      for (let index = 0; index < EDITS_NEEDED; index += 1) {
        rename(index);
      }
      return batched(BATCH_SIZE, () => {
        expect(session.history.undo().ok).toBe(true);
      });
    };
    const ratio = growthRatio(undoer(smallDocument), undoer(largeDocument));
    console.info(`Undo: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});

describe('growth of opening a shared session and of a full repair', () => {
  const smallProject = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const largeProject = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  it('opens a session on a shared document in linear time', () => {
    const smallState = Y.encodeStateAsUpdate(createSharedDocument(smallProject, TEST_DOCUMENT_ID));
    const largeState = Y.encodeStateAsUpdate(createSharedDocument(largeProject, TEST_DOCUMENT_ID));
    /** Opens a session from a saved state. */
    const open = (state: Uint8Array) => (): void => {
      const document = new Y.Doc();
      Y.applyUpdate(document, state);
      if (!openSharedSession(document).ok) {
        throw new Error('Session refused');
      }
    };
    const ratio = growthRatio(open(smallState), open(largeState));
    console.info(`Session opening: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('repairs a whole project in linear time', () => {
    const ratio = growthRatio(
      () => repairProject(smallProject),
      () => repairProject(largeProject),
    );
    console.info(`Full repair: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
