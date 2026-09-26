import { compileCalendar, type CalendarError } from '../calendar/compile-calendar';
import type { Project, Task, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { isProjectHour } from '../time';
import { runBackwardPass, type TaskFloat } from './backward-pass';
import {
  runForwardPass,
  type SchedulingConflict,
  type SchedulingContext,
  type TaskPlacementError,
} from './forward-pass';
import { analyzeProjectStructure, type StructureError } from './project-structure';
import { computeSummaries, type SummarySchedule } from './summaries';
import type { Placement } from './task-placement';
import { computeWbsNumbers } from './wbs';

export interface Schedule {
  readonly placements: ReadonlyMap<TaskId, Placement>;
  readonly summaries: ReadonlyMap<TaskId, SummarySchedule>;
  readonly wbsNumbers: ReadonlyMap<TaskId, string>;
  readonly floats: ReadonlyMap<TaskId, TaskFloat> | null;
  readonly conflicts: readonly SchedulingConflict[];
}

export type SchedulingFailure =
  | { readonly kind: 'calendar'; readonly errors: readonly CalendarError[] }
  | { readonly kind: 'startDate' }
  | { readonly kind: 'structure'; readonly errors: readonly StructureError[] }
  | { readonly kind: 'task'; readonly error: TaskPlacementError };

/** Computes the full schedule of a project: dates, summaries, numbering, floats and conflicts. */
export function scheduleProject(project: Project): Result<Schedule, SchedulingFailure> {
  const calendar = compileCalendar(project.calendar);
  if (!calendar.ok) {
    return failure({ kind: 'calendar', errors: calendar.error });
  }
  if (!isProjectHour(project.startDate)) {
    return failure({ kind: 'startDate' });
  }
  const structure = analyzeProjectStructure(project);
  if (!structure.ok) {
    return failure({ kind: 'structure', errors: structure.error });
  }
  const context: SchedulingContext = {
    calendar: calendar.value,
    projectStart: project.startDate,
    dateConstraintsEnabled: project.options.dateConstraintsEnabled,
  };
  const { tasks, graph, childrenByParent } = structure.value;
  const forward = runForwardPass(context, graph);
  if (!forward.ok) {
    return failure({ kind: 'task', error: forward.error });
  }
  const floats = project.options.criticalPathEnabled
    ? runBackwardPass(context, graph, forward.value.placements)
    : success(null);
  if (!floats.ok) {
    return failure({ kind: 'task', error: floats.error });
  }
  const placements = keyByTaskId(tasks, forward.value.placements);
  return success({
    placements,
    summaries: computeSummaries(tasks, childrenByParent, placements),
    wbsNumbers: computeWbsNumbers(childrenByParent),
    floats: floats.value === null ? null : keyByTaskId(tasks, floats.value),
    conflicts: forward.value.conflicts,
  });
}

/** Turns values stored by task index into a map keyed by task identifier, skipping missing ones. */
function keyByTaskId<T>(
  tasks: readonly Task[],
  valuesByIndex: readonly (T | undefined)[],
): Map<TaskId, T> {
  const byId = new Map<TaskId, T>();
  valuesByIndex.forEach((value, index) => {
    const task = tasks[index];
    if (value !== undefined && task !== undefined) {
      byId.set(task.id, value);
    }
  });
  return byId;
}
