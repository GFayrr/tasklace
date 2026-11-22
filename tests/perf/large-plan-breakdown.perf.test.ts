import { deserialize, serialize, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { encodeTasklaceFile, readTasklaceDocument } from '../../src/core/file/tasklace-file';
import type { Project, TaskId } from '../../src/core/model/project';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import {
  openSharedSession,
  openSharedSessionFromState,
  type SharedSession,
} from '../../src/core/shared/shared-session';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { conflictLines, dateConflictLines } from '../../src/renderer/plan/conflict-lines';
import {
  applyScheduleDelta,
  descriptionAfter,
  projectDeltaOf,
  scheduleTableOf,
} from '../../src/renderer/schedule/schedule-changes';
import { createScheduleHost } from '../../src/renderer/schedule/schedule-host';
import {
  isScheduleResponse,
  SCHEDULE_PROTOCOL_VERSION,
} from '../../src/renderer/schedule/schedule-protocol';
import { valueAt } from '../../src/core/table-value';
import { HOURS_PER_DAY } from '../../src/core/time';
import {
  buildPlanOutline,
  groupIncoming,
  nextIncoming,
  nextPlanOutline,
  NOTHING_COLLAPSED,
} from '../../src/renderer/plan/plan-outline';
import { tagStylesOf } from '../../src/renderer/plan/tag-styles';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import { medianDuration } from '../growth/measure-growth';

const USUAL_TASK_COUNT = 10_000;
const LARGEST_TASK_COUNT = 50_000;
const TASK_COUNTS =
  process.env['TASKLACE_BENCH_LARGEST'] === '1'
    ? [USUAL_TASK_COUNT, LARGEST_TASK_COUNT]
    : [USUAL_TASK_COUNT];
const MEBIBYTE = 1_048_576;
const MEASURED_RUNS = 5;
const TIMEOUT_MILLISECONDS = 1_800_000;

/** Opens a session on a copy of a document, failing the test when it cannot be opened. */
function openCopy(document: Y.Doc): SharedSession {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}

/** Measures the median duration of a step and writes it to the console with its label. */
function report(label: string, step: (index: number) => void): number {
  const duration = medianDuration(step, MEASURED_RUNS);
  console.info(`${label.padEnd(44)} ${duration.toFixed(1).padStart(8)} ms`);
  return duration;
}

/** Tells whether a value can be called without arguments. */
function isCallable(value: unknown): value is () => void {
  return typeof value === 'function';
}

/** Collects the garbage, then returns the bytes the heap holds. */
function heapBytes(): number {
  setFlagsFromString('--expose-gc');
  const collect: unknown = runInNewContext('gc');
  if (!isCallable(collect)) {
    throw new Error('The garbage collector cannot be called.');
  }
  collect();
  return process.memoryUsage().heapUsed;
}

/** Schedules a project, failing the test when it cannot be scheduled. */
function scheduleOf(project: Project) {
  const schedule = scheduleProject(project);
  if (!schedule.ok) {
    throw new Error('The large project cannot be scheduled.');
  }
  return schedule.value;
}

describe.each(TASK_COUNTS)('where the time goes in a plan of %i tasks', (taskCount) => {
  it(
    'measures each step of an edit, of a large merge and of an opening',
    () => {
      const origin = createSharedDocument(
        buildLargeProject(LARGE_PROJECT_SEED, taskCount),
        TEST_DOCUMENT_ID,
      );
      const heapBefore = heapBytes();
      const session = openCopy(origin);
      console.info(
        `heap held by an open session: ${((heapBytes() - heapBefore) / MEBIBYTE).toFixed(0)} MiB`,
      );
      const tasks = session.project().tasks;
      console.info(`--- ${String(taskCount)} tasks ---`);
      report('apply (rename one task)', (index) => {
        const task = tasks[index];
        if (task !== undefined) {
          session.apply({ type: 'putTask', task: { ...task, name: `Renamed ${String(index)}` } });
        }
      });
      report('apply + session.project()', (index) => {
        const task = tasks[index];
        if (task !== undefined) {
          session.apply({ type: 'putTask', task: { ...task, name: `Again ${String(index)}` } });
        }
        session.project();
      });
      const start = session.project();
      let outline = nextPlanOutline(null, start.tasks, NOTHING_COLLAPSED);
      let incoming = nextIncoming(null, start.dependencies);
      report('rename + project + outline + incoming', (index) => {
        const task = valueAt(tasks, index);
        const applied = session.apply({
          type: 'putTask',
          task: { ...task, name: `Once more ${String(index)}` },
        });
        expect(applied.ok).toBe(true);
        const next = session.project();
        outline = nextPlanOutline(outline, next.tasks, NOTHING_COLLAPSED);
        incoming = nextIncoming(incoming, next.dependencies);
      });
      const links = start.dependencies;
      report('lag + project + outline + incoming', (index) => {
        const dependency = valueAt(links, index);
        const applied = session.apply({
          type: 'putDependency',
          dependency: { ...dependency, lagHours: dependency.lagHours + 1 },
        });
        expect(applied.ok).toBe(true);
        const next = session.project();
        outline = nextPlanOutline(outline, next.tasks, NOTHING_COLLAPSED);
        incoming = nextIncoming(incoming, next.dependencies);
      });
      report('move a task and back + project + outline (2 edits)', (index) => {
        const task = valueAt(tasks, index);
        const other = valueAt(tasks, (index * 7919) % tasks.length);
        for (const sortKey of [other.sortKey, task.sortKey]) {
          const moved = session.apply({ type: 'putTask', task: { ...task, sortKey } });
          expect(moved.ok).toBe(true);
          outline = nextPlanOutline(outline, session.project().tasks, NOTHING_COLLAPSED);
        }
      });
      report('outline walked again (collapsed set changed)', (index) => {
        const collapsed: ReadonlySet<TaskId> =
          index % 2 === 0 ? new Set([valueAt(tasks, 0).id]) : NOTHING_COLLAPSED;
        outline = nextPlanOutline(outline, session.project().tasks, collapsed);
      });
      const project = session.project();
      report('buildPlanOutline', () => buildPlanOutline(project.tasks, new Set()));
      report('groupIncoming', () => groupIncoming(project.dependencies));
      report('tagStylesOf', () => tagStylesOf(project));
      report('structuredClone(project) (to the worker)', () => structuredClone(project));
      report('scheduleProject', () => scheduleOf(project));
      const schedule = scheduleOf(project);
      report('structuredClone(schedule) (from the worker)', () => structuredClone(schedule));
      report('conflictLines', () => conflictLines(schedule, project));
      report('dateConflictLines', () => dateConflictLines(schedule, project));
      /** Prepares the page side of the schedule for an edit: the changes sent, the answer read back as the page reads a message whose packed lists the worker hands over, and applied to the schedule table the page keeps, with the conflicts. */
      const pageSide = (before: Project, next: Project) => {
        const host = createScheduleHost();
        const first = host.answer({
          version: SCHEDULE_PROTOCOL_VERSION,
          generation: 1,
          kind: 'whole',
          project: before,
        });
        const request = {
          version: SCHEDULE_PROTOCOL_VERSION,
          generation: 2,
          kind: 'changes',
          basis: 1,
          changes: projectDeltaOf(before, next),
        } as const;
        const message = serialize(host.answer(structuredClone(request)));
        if (!first.result.ok || first.result.value.kind !== 'whole') {
          throw new Error('The first schedule was not whole.');
        }
        const table = scheduleTableOf(first.result.value.schedule);
        const described = descriptionAfter(null, first.description);
        return () => {
          structuredClone(projectDeltaOf(before, next));
          const received: unknown = deserialize(message);
          if (!isScheduleResponse(received)) {
            throw new Error('The answer of the worker cannot be read.');
          }
          if (received.result.ok && received.result.value.kind === 'changes') {
            applyScheduleDelta(table, received.result.value.changes);
          }
          descriptionAfter(described, received.description);
        };
      };
      const firstTask = valueAt(project.tasks, 0);
      const critical = { ...project, options: { ...project.options, criticalPathEnabled: true } };
      report(
        'schedule, page side of a rename',
        pageSide(project, {
          ...project,
          tasks: project.tasks.with(0, { ...firstTask, name: 'Renamed' }),
        }),
      );
      report(
        'schedule, page side of a start moved a day later',
        pageSide(project, { ...project, startDate: project.startDate + HOURS_PER_DAY }),
      );
      report(
        'same, with the critical path',
        pageSide(critical, { ...critical, startDate: critical.startDate + HOURS_PER_DAY }),
      );
      report('scheduleTableOf (copy, measured apart)', () => scheduleTableOf(schedule));

      const remote = openCopy(origin);
      const before = Y.encodeStateVector(new Y.Doc());
      remote.applyAll(
        remote.project().tasks.map((task, index) => ({
          type: 'putTask' as const,
          task: { ...task, name: `Remote ${String(index)}` },
        })),
      );
      const update = remote.encodeState(before);
      console.info(`update renaming every task: ${(update.byteLength / MEBIBYTE).toFixed(1)} MiB`);
      const withMerge = report('openCopy + merge (every task renamed)', () => {
        openCopy(origin).merge(update);
      });
      const openingAlone = report('openCopy + prepareTrialCopy (trial copy made)', () => {
        openCopy(origin).prepareTrialCopy();
      });
      console.info(`merge alone: about ${(withMerge - openingAlone).toFixed(0)} ms`);

      const file = encodeTasklaceFile(origin, zlibCompressor);
      console.info(`file: ${(file.byteLength / MEBIBYTE).toFixed(1)} MiB`);
      report('readTasklaceDocument (worker)', () => readTasklaceDocument(file, zlibCompressor));
      const read = readTasklaceDocument(file, zlibCompressor);
      if (!read.ok) {
        throw new Error('File refused');
      }
      report('openSharedSessionFromState (page, until the plan can be shown)', () =>
        openSharedSessionFromState(read.value.state),
      );
      report(
        'openSharedSessionFromState + prepareTrialCopy (page, trial copy made after a paint)',
        () => {
          const opened = openSharedSessionFromState(read.value.state);
          if (opened.ok) {
            opened.value.prepareTrialCopy();
          }
        },
      );
      expect(project.tasks).toHaveLength(taskCount);
    },
    TIMEOUT_MILLISECONDS,
  );
});
