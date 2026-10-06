import type { SkippedTask } from '../../core/baseline/take-baseline';
import type { Baseline, BaselineEntry, Task, TaskId } from '../../core/model/project';

const ENTRIES_BY_BASELINE = new WeakMap<Baseline, ReadonlyMap<TaskId, BaselineEntry>>();

/** Returns the frozen dates of a baseline by task, built at the first request for that baseline and kept with it. */
export function entriesByTask(baseline: Baseline): ReadonlyMap<TaskId, BaselineEntry> {
  const known = ENTRIES_BY_BASELINE.get(baseline);
  if (known !== undefined) {
    return known;
  }
  const entries = new Map(baseline.entries.map((entry) => [entry.taskId, entry]));
  ENTRIES_BY_BASELINE.set(baseline, entries);
  return entries;
}

/** Lists the tasks a new baseline could not freeze, leaving out the empty summaries, which have no dates to freeze. */
export function unfrozenTasks(
  skipped: readonly SkippedTask[],
  tasks: readonly Task[],
): readonly SkippedTask[] {
  const summaries = new Set(tasks.filter((task) => task.kind === 'summary').map((task) => task.id));
  return skipped.filter((task) => task.reason !== 'NO_DATES' || !summaries.has(task.taskId));
}
