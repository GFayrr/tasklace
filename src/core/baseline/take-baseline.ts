import type { CompiledCalendar } from '../calendar/compile-calendar';
import { countWorkingHours } from '../calendar/working-time';
import type { Baseline, BaselineEntry, Project, Task, TaskId } from '../model/project';
import type { Schedule } from '../scheduling/schedule-project';
import { isProjectHour, type ProjectHour } from '../time';

export interface TakenBaseline {
  readonly baseline: Baseline;
  readonly skippedTaskIds: readonly TaskId[];
}

/** Freezes the scheduled start, end and duration of every task, skipping those whose dates cannot be stored. */
export function takeBaseline(
  project: Pick<Project, 'tasks'>,
  schedule: Pick<Schedule, 'placements' | 'summaries'>,
  calendar: CompiledCalendar,
  takenAt: ProjectHour,
): TakenBaseline {
  const entries: BaselineEntry[] = [];
  const skippedTaskIds: TaskId[] = [];
  for (const task of project.tasks) {
    const entry = freezeTask(task, schedule, calendar);
    if (entry === null) {
      skippedTaskIds.push(task.id);
    } else {
      entries.push(entry);
    }
  }
  return { baseline: { takenAt, entries }, skippedTaskIds };
}

/** Returns the frozen dates of one task, or null when it has no dates or they fall outside the supported period. */
function freezeTask(
  task: Task,
  schedule: Pick<Schedule, 'placements' | 'summaries'>,
  calendar: CompiledCalendar,
): BaselineEntry | null {
  const dates =
    task.kind === 'summary' ? schedule.summaries.get(task.id) : schedule.placements.get(task.id);
  const start = dates?.start ?? null;
  const end = dates?.end ?? null;
  if (start === null || end === null || !isProjectHour(start) || !isProjectHour(end)) {
    return null;
  }
  const durationHours = frozenDuration(task, start, end, calendar);
  return durationHours === null ? null : { taskId: task.id, start, end, durationHours };
}

/** Returns the duration of a task: its blocks for a work task, zero for a milestone, working hours for a summary. */
function frozenDuration(
  task: Task,
  start: ProjectHour,
  end: ProjectHour,
  calendar: CompiledCalendar,
): number | null {
  if (task.kind === 'task') {
    return task.segments.reduce((total, segment) => total + segment.durationHours, 0);
  }
  if (task.kind === 'milestone') {
    return 0;
  }
  const hours = countWorkingHours(calendar, start, end);
  return hours.ok ? hours.value : null;
}
