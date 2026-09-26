import type { WorkingCalendar } from './calendar';

export type TaskId = string;
export type DependencyId = string;
export type TagId = string;

export type TaskKind = 'task' | 'milestone' | 'summary';

export interface Task {
  readonly id: TaskId;
  readonly kind: TaskKind;
  readonly name: string;
  readonly parentId: TaskId | null;
  readonly durationHours: number;
  readonly hoursPerDay: number | null;
  readonly dailyStartHour: number | null;
  readonly progressPercent: number;
  readonly tagId: TagId | null;
}

export type DependencyType = 'finishToStart' | 'startToStart' | 'finishToFinish' | 'startToFinish';

export interface Dependency {
  readonly id: DependencyId;
  readonly predecessorId: TaskId;
  readonly successorId: TaskId;
  readonly type: DependencyType;
  readonly lagHours: number;
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color: string;
  readonly representsPersonOrTeam: boolean;
}

export interface Project {
  readonly name: string;
  readonly calendar: WorkingCalendar;
  readonly tasks: readonly Task[];
  readonly dependencies: readonly Dependency[];
  readonly tags: readonly Tag[];
}
