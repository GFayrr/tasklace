import type { CompiledCalendar } from '../calendar/compile-calendar';
import { countWorkingHours } from '../calendar/working-time';
import type { Baseline, BaselineEntry, Project, Task, TaskId } from '../model/project';
import type { Schedule } from '../scheduling/schedule-project';
import { isProjectHour, type ProjectHour } from '../time';

export type SkipReason = 'NO_DATES' | 'OUT_OF_PERIOD';

export interface SkippedTask {
  readonly taskId: TaskId;
  readonly reason: SkipReason;
}

export interface TakenBaseline {
  readonly baseline: Baseline;
  readonly skipped: readonly SkippedTask[];
}

/** Freezes the scheduled start, end and duration of every task, listing with a reason those that cannot be frozen. */
export function takeBaseline(
  project: Pick<Project, 'tasks'>,
  schedule: Pick<Schedule, 'placements' | 'summaries'>,
  calendar: CompiledCalendar,
  takenAt: ProjectHour,
): TakenBaseline {
  const entries: BaselineEntry[] = [];
  const skipped: SkippedTask[] = [];
  for (const task of project.tasks) {
    const entry = freezeTask(task, schedule, calendar);
    if (typeof entry === 'string') {
      skipped.push({ taskId: task.id, reason: entry });
    } else {
      entries.push(entry);
    }
  }
  return { baseline: { takenAt, entries }, skipped };
}

/** Returns the frozen dates and duration of one task, or the reason why they cannot be frozen. */
function freezeTask(
  task: Task,
  schedule: Pick<Schedule, 'placements' | 'summaries'>,
  calendar: CompiledCalendar,
): BaselineEntry | SkipReason {
  const dates =
    task.kind === 'summary' ? schedule.summaries.get(task.id) : schedule.placements.get(task.id);
  const start = dates?.start ?? null;
  const end = dates?.end ?? null;
  if (start === null || end === null) {
    return 'NO_DATES';
  }
  const durationHours =
    isProjectHour(start) && isProjectHour(end) ? frozenDuration(task, start, end, calendar) : null;
  return durationHours === null ? 'OUT_OF_PERIOD' : { taskId: task.id, start, end, durationHours };
}

/** Returns the duration of a task: its blocks for a work task, zero for a milestone, working hours for a summary, or null when those hours cannot be counted. */
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
