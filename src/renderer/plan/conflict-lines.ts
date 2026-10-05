import type { Project, TaskId } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
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

/** Describes each conflict of a schedule with the name, color and pattern of its tag and the names of its tasks, throwing on a conflict about a tag or a task the project does not have. */
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
