import type { ProjectHour } from '../time';
import type { WorkingCalendar } from './calendar';

export type TaskId = string;
export type DependencyId = string;
export type TagId = string;

export interface TaskSegment {
  readonly durationHours: number;
  readonly gapDaysBefore: number;
  readonly startNoEarlierThan: ProjectHour | null;
}

interface TaskBase {
  readonly id: TaskId;
  readonly name: string;
  readonly parentId: TaskId | null;
  readonly sortKey: string;
}

interface DatedTaskBase extends TaskBase {
  readonly progressPercent: number;
  readonly tagId: TagId | null;
  readonly startNoEarlierThan: ProjectHour | null;
  readonly mustFinishOn: ProjectHour | null;
  readonly deadline: ProjectHour | null;
}

export interface WorkTask extends DatedTaskBase {
  readonly kind: 'task';
  readonly segments: readonly TaskSegment[];
  readonly hoursPerDay: number | null;
  readonly dailyStartHour: number | null;
}

export interface Milestone extends DatedTaskBase {
  readonly kind: 'milestone';
}

export interface SummaryTask extends TaskBase {
  readonly kind: 'summary';
}

export type Task = WorkTask | Milestone | SummaryTask;
export type SchedulableTask = WorkTask | Milestone;

export type DependencyType = 'finishToStart' | 'startToStart' | 'finishToFinish' | 'startToFinish';

export interface Dependency {
  readonly id: DependencyId;
  readonly predecessorId: TaskId;
  readonly successorId: TaskId;
  readonly type: DependencyType;
  readonly lagHours: number;
  readonly predecessorBlock: number | null;
  readonly successorBlock: number | null;
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color: string;
  readonly representsPersonOrTeam: boolean;
}

export interface ProjectOptions {
  readonly criticalPathEnabled: boolean;
  readonly dateConstraintsEnabled: boolean;
  readonly alwaysShowPatterns: boolean;
}

export interface BaselineEntry {
  readonly taskId: TaskId;
  readonly start: ProjectHour;
  readonly end: ProjectHour;
  readonly durationHours: number;
}

export interface Baseline {
  readonly takenAt: ProjectHour;
  readonly entries: readonly BaselineEntry[];
}

export interface Project {
  readonly name: string;
  readonly startDate: ProjectHour;
  readonly calendar: WorkingCalendar;
  readonly options: ProjectOptions;
  readonly tasks: readonly Task[];
  readonly dependencies: readonly Dependency[];
  readonly tags: readonly Tag[];
  readonly baseline: Baseline | null;
}
