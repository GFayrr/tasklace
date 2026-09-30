import { DEFAULT_CALENDAR } from '../calendar/default-calendar';
import type {
  Dependency,
  DependencyType,
  Milestone,
  Project,
  SummaryTask,
  Task,
  WorkTask,
} from '../model/project';
import { scheduleProject, type Schedule } from '../scheduling/schedule-project';
import { at } from './civil-time';

export const TEST_DOCUMENT_ID = '00000000-0000-4000-8000-000000000001';

export const PROJECT_START = at(2026, 9, 28, 9);

/** Builds a one-block work task of 7 hours with no constraint, then applies overrides. */
export function workTask(id: string, overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    kind: 'task',
    id,
    name: id,
    parentId: null,
    sortKey: id,
    segments: [{ durationHours: 7, gapDaysBefore: 0 }],
    hoursPerDay: null,
    dailyStartHour: null,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
    ...overrides,
  };
}

/** Builds a work task made of several blocks with the given durations and gaps in days. */
export function splitTask(
  id: string,
  blocks: readonly (readonly [durationHours: number, gapDaysBefore: number])[],
  overrides: Partial<WorkTask> = {},
): WorkTask {
  const segments = blocks.map(([durationHours, gapDaysBefore]) => ({
    durationHours,
    gapDaysBefore,
  }));
  return workTask(id, { segments, ...overrides });
}

/** Builds a milestone with no constraint, then applies overrides. */
export function milestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
  return {
    kind: 'milestone',
    id,
    name: id,
    parentId: null,
    sortKey: id,
    progressPercent: 0,
    tagId: null,
    startNoEarlierThan: null,
    mustFinishOn: null,
    deadline: null,
    ...overrides,
  };
}

/** Builds a summary task, then applies overrides. */
export function summary(id: string, overrides: Partial<SummaryTask> = {}): SummaryTask {
  return { kind: 'summary', id, name: id, parentId: null, sortKey: id, ...overrides };
}

/** Builds a dependency identified by its two tasks. */
export function link(
  predecessorId: string,
  successorId: string,
  type: DependencyType = 'finishToStart',
  lagHours = 0,
): Dependency {
  return { id: `${predecessorId}-${successorId}`, predecessorId, successorId, type, lagHours };
}

/** Builds a project starting on Monday 28 September 2026 at 09:00 with the default calendar. */
export function project(
  tasks: readonly Task[],
  dependencies: readonly Dependency[] = [],
  overrides: Partial<Project> = {},
): Project {
  return {
    name: 'Test project',
    startDate: PROJECT_START,
    calendar: DEFAULT_CALENDAR,
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
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
