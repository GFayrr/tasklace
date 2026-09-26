import { compareStrings } from '../compare-strings';
import type { Task, TaskId } from '../model/project';

/** Numbers every task by its position in the task tree (1, 1.1, 1.2, 2…). */
export function computeWbsNumbers(
  childrenByParent: ReadonlyMap<TaskId | null, readonly Task[]>,
): ReadonlyMap<TaskId, string> {
  const numbers = new Map<TaskId, string>();
  const pending: { readonly parentId: TaskId | null; readonly prefix: string }[] = [
    { parentId: null, prefix: '' },
  ];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const children = sortSiblings(childrenByParent.get(entry.parentId) ?? []);
    const { prefix } = entry;
    children.forEach((child, index) => {
      const number = `${prefix}${String(index + 1)}`;
      numbers.set(child.id, number);
      pending.push({ parentId: child.id, prefix: `${number}.` });
    });
  }
  return numbers;
}

/** Sorts sibling tasks by their sort key, then by identifier to break ties. */
function sortSiblings(siblings: readonly Task[]): Task[] {
  return [...siblings].sort(
    (left, right) =>
      compareStrings(left.sortKey, right.sortKey) || compareStrings(left.id, right.id),
  );
}
