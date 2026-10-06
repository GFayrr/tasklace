import { compareWbsNumbers } from '../../core/exchange/csv/task-notations';
import type { Project, SchedulableTask, Task, TaskId } from '../../core/model/project';
import type {
  SchedulingConflict,
  SchedulingConflictCode,
} from '../../core/scheduling/forward-pass';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { ProjectHour } from '../../core/time';
import type { TagPattern } from '../../core/tags/tag-appearance';
import type { TagConflict } from '../../core/tags/tag-conflicts';
import { tagStylesOf } from './tag-styles';

export interface ConflictLine {
  readonly conflict: TagConflict;
  readonly tagName: string;
  readonly color: string;
  readonly pattern: TagPattern | null;
  readonly taskNames: readonly string[];
}

const CONSTRAINT_OF: Readonly<
  Record<SchedulingConflictCode, (task: SchedulableTask) => ProjectHour | null>
> = {
  DEADLINE_MISSED: (task) => task.deadline,
  MUST_FINISH_ON_NOT_MET: (task) => task.mustFinishOn,
};

export interface DateConflictLine {
  readonly conflict: SchedulingConflict;
  readonly taskName: string;
  readonly end: ProjectHour;
  readonly date: ProjectHour;
}

/** Describes each person or team conflict of a schedule with the name, color and pattern of its tag and the names of its tasks, throwing on a conflict about a tag or a task the project does not have. */
export function conflictLines(
  schedule: Schedule | null,
  project: Project,
): readonly ConflictLine[] {
  const tags = new Map(project.tags.map((tag) => [tag.id, tag]));
  const taskNames = new Map<TaskId, string>(project.tasks.map((task) => [task.id, task.name]));
  const styles = tagStylesOf(project);
  return (schedule?.tagConflicts.conflicts ?? []).map((conflict) => {
    const tag = tags.get(conflict.tagId);
    if (tag === undefined) {
      throw new Error(`A conflict is about the unknown tag ${conflict.tagId}.`);
    }
    return {
      conflict,
      tagName: tag.name,
      color: tag.color,
      pattern: styles.get(tag.id)?.pattern ?? null,
      taskNames: conflict.taskIds.map((id) => nameOf(taskNames, id)),
    };
  });
}

/** Returns the name of a task, throwing when the project does not have it. */
function nameOf(taskNames: ReadonlyMap<TaskId, string>, id: TaskId): string {
  const name = taskNames.get(id);
  if (name === undefined) {
    throw new Error(`A conflict is about the unknown task ${id}.`);
  }
  return name;
}

/** Describes each date a task of a schedule does not meet with the name of the task, its end and the date it misses, in the order of the task table, throwing on a conflict about a task the project or the schedule does not have, or without its date. */
export function dateConflictLines(
  schedule: Schedule | null,
  project: Project,
): readonly DateConflictLine[] {
  if (schedule === null || schedule.conflicts.length === 0) {
    return [];
  }
  const tasks = new Map<TaskId, Task>(project.tasks.map((task) => [task.id, task]));
  const lines = schedule.conflicts.map((conflict) => ({
    line: describeDateConflict(schedule, tasks, conflict),
    wbs: valueOf(schedule.wbsNumbers, conflict.taskId),
  }));
  return lines
    .sort((left, right) => compareWbsNumbers(left.wbs, right.wbs))
    .map(({ line }) => line);
}

/** Describes one date a task does not meet, throwing when the project or the schedule does not have the task, or the task does not have the date. */
function describeDateConflict(
  schedule: Schedule,
  tasks: ReadonlyMap<TaskId, Task>,
  conflict: SchedulingConflict,
): DateConflictLine {
  const task = tasks.get(conflict.taskId);
  if (task === undefined) {
    throw new Error(`A conflict is about the unknown task ${conflict.taskId}.`);
  }
  const end = valueOf(schedule.placements, conflict.taskId).end;
  const date = task.kind === 'summary' ? null : CONSTRAINT_OF[conflict.code](task);
  if (date === null) {
    throw new Error(`The task ${task.id} has no date for its conflict ${conflict.code}.`);
  }
  return { conflict, taskName: task.name, end, date };
}

/** Returns what a table of the schedule holds for the task of a conflict, throwing when it holds nothing. */
function valueOf<Value>(table: ReadonlyMap<TaskId, Value>, taskId: TaskId): Value {
  const value = table.get(taskId);
  if (value === undefined) {
    throw new Error(`The schedule has nothing for the task ${taskId} of a conflict.`);
  }
  return value;
}
