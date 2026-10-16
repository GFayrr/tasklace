import { TEST_CALENDAR } from './test-calendar';
import type {
  Dependency,
  DependencyType,
  Milestone,
  Project,
  SummaryTask,
  Task,
  TaskSegment,
  TaskSegments,
  WorkTask,
} from '../model/project';
import { scheduleProject, type Schedule } from '../scheduling/schedule-project';
import type { ProjectHour } from '../time';
import { at } from './civil-time';
import { nonEmptySegments } from '../task-segments';
import { requireIdentifier, type NewIdentifier } from '../identifiers';
import { requireDocumentId, type DocumentId } from '../shared/shared-document';

/** Gives any text as a document identifier, to check that a forged one is still refused where it is used. */
export function forgedDocumentId(text: string): DocumentId {
  return text as DocumentId;
}

export const TEST_DOCUMENT_ID = requireDocumentId('00000000-0000-4000-8000-000000000001');

export const PROJECT_START = at(2026, 9, 28, 9);

/** The overrides of a task as tests write them, its parent and tag named by plain text checked as identifiers. */
export type TaskOverrides<T extends Task> = Partial<
  Omit<T, 'parentId' | 'tagId'> & {
    readonly parentId: string | null;
    readonly tagId: string | null;
  }
>;

/** Gives a text written by a test as an identifier of a task, a link or a tag, failing the test for an invalid one. */
export function testId(text: string): NewIdentifier {
  return requireIdentifier(text);
}

/** Turns the overrides of a test into those of a task, checking the identifiers they name. */
function checkedOverrides<T extends Task>(overrides: TaskOverrides<T>): Partial<T> {
  const { parentId, tagId, ...rest } = overrides;
  const checked: Record<string, unknown> = { ...rest };
  if (parentId !== undefined) {
    checked['parentId'] = parentId === null ? null : testId(parentId);
  }
  if (tagId !== undefined) {
    checked['tagId'] = tagId === null ? null : testId(tagId);
  }
  return checked as Partial<T>;
}

/** Builds a one-block work task of 7 hours with no constraint, then applies overrides. */
export function workTask(id: string, overrides: TaskOverrides<WorkTask> = {}): WorkTask {
  return {
    kind: 'task',
    id: testId(id),
    name: id,
    parentId: null,
    sortKey: id,
    segments: [{ durationHours: 7, gapDaysBefore: 0, startNoEarlierThan: null }],
    hoursPerDay: null,
    dailyStartHour: null,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
    ...checkedOverrides(overrides),
  };
}

/** Builds a work task made of several blocks with the given durations and gaps in days. */
export function splitTask(
  id: string,
  blocks: readonly (readonly [
    durationHours: number,
    gapDaysBefore: number,
    startNoEarlierThan?: ProjectHour,
  ])[],
  overrides: TaskOverrides<WorkTask> = {},
): WorkTask {
  const segments = segmentsOrThrow(
    blocks.map(([durationHours, gapDaysBefore, startNoEarlierThan]) => ({
      durationHours,
      gapDaysBefore,
      startNoEarlierThan: startNoEarlierThan ?? null,
    })),
  );
  return workTask(id, { segments, ...overrides });
}

/** Gives a list of blocks as the blocks of a work task, failing the test for an empty list. */
export function segmentsOrThrow(segments: readonly TaskSegment[]): TaskSegments {
  const blocks = nonEmptySegments(segments);
  if (blocks === null) {
    throw new Error('A work task needs one block at least.');
  }
  return blocks;
}

/** Builds a milestone with no constraint, then applies overrides. */
export function milestone(id: string, overrides: TaskOverrides<Milestone> = {}): Milestone {
  return {
    kind: 'milestone',
    id: testId(id),
    name: id,
    parentId: null,
    sortKey: id,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
    ...checkedOverrides(overrides),
  };
}

/** Builds a summary task, then applies overrides. */
export function summary(id: string, overrides: TaskOverrides<SummaryTask> = {}): SummaryTask {
  return {
    kind: 'summary',
    id: testId(id),
    name: id,
    parentId: null,
    sortKey: id,
    ...checkedOverrides(overrides),
  };
}

/** Builds a dependency identified by its two tasks. */
export function link(
  predecessorId: string,
  successorId: string,
  type: DependencyType = 'finishToStart',
  lagHours = 0,
): Dependency {
  return {
    id: testId(`${predecessorId}-${successorId}`),
    predecessorId: testId(predecessorId),
    successorId: testId(successorId),
    type,
    lagHours,
    predecessorBlock: null,
    successorBlock: null,
  };
}

/** Builds a dependency from or to blocks of split tasks, the block numbers counting from 0. */
export function blockLink(
  predecessorId: string,
  successorId: string,
  blocks: { readonly from?: number; readonly to?: number },
  type: DependencyType = 'finishToStart',
  lagHours = 0,
): Dependency {
  const from = blocks.from ?? null;
  const to = blocks.to ?? null;
  return {
    ...link(predecessorId, successorId, type, lagHours),
    id: testId(
      `${predecessorId}${from === null ? '' : `_${String(from)}`}-${successorId}${to === null ? '' : `_${String(to)}`}`,
    ),
    predecessorBlock: from,
    successorBlock: to,
  };
}

/** Builds a project starting on Monday 28 September 2026 at 09:00 with the test calendar, whose working day has a lunch break. */
export function project(
  tasks: readonly Task[],
  dependencies: readonly Dependency[] = [],
  overrides: Partial<Project> = {},
): Project {
  return {
    name: 'Test project',
    startDate: PROJECT_START,
    calendar: TEST_CALENDAR,
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
      baselineEnabled: false,
      alwaysShowPatterns: false,
    },
    tasks,
    dependencies,
    tags: [],
    baseline: null,
    ...overrides,
  };
}

/** Schedules a project, failing the test when scheduling fails. */
export function scheduleOrThrow(input: Project): Schedule {
  const result = scheduleProject(input);
  if (!result.ok) {
    throw new Error(`Scheduling failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
