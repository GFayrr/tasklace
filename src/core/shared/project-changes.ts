import { compareStrings } from '../compare-strings';
import { valueAt } from '../table-value';
import type { Dependency, DependencyId, Project, Tag, TagId, Task, TaskId } from '../model/project';

export interface ListChanges<Item, Id> {
  readonly put: readonly Item[];
  readonly removed: readonly Id[];
}

export interface ProjectChanges {
  readonly header: boolean;
  readonly tasks: ListChanges<Task, TaskId>;
  readonly dependencies: ListChanges<Dependency, DependencyId>;
  readonly tags: ListChanges<Tag, TagId>;
}

const LIST_KEYS: ReadonlySet<string> = new Set(['tasks', 'dependencies', 'tags']);

/** Lists what changed from one project of a session to the next: items added or replaced, items removed, and whether a field of the header changed, comparing by identity so that an untouched list costs nothing and a touched one a single walk. */
export function projectChanges(previous: Project, next: Project): ProjectChanges {
  return {
    header: headerChanged(previous, next),
    tasks: listChanges(previous.tasks, next.tasks),
    dependencies: listChanges(previous.dependencies, next.dependencies),
    tags: listChanges(previous.tags, next.tags),
  };
}

/** Tells whether one of the fields of two projects other than their lists holds a different value, compared by identity. */
function headerChanged(previous: Project, next: Project): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].some(
    (key) => !LIST_KEYS.has(key) && Reflect.get(previous, key) !== Reflect.get(next, key),
  );
}

/** Compares two lists sorted by identifier in one walk, giving the items of the second that are new or not the same object and the identifiers the second no longer has. */
function listChanges<Id extends string, Item extends { readonly id: Id }>(
  previous: readonly Item[],
  next: readonly Item[],
): ListChanges<Item, Id> {
  const put: Item[] = [];
  const removed: Id[] = [];
  if (previous === next) {
    return { put, removed };
  }
  let before = 0;
  let after = 0;
  while (before < previous.length && after < next.length) {
    const old = valueAt(previous, before);
    const current = valueAt(next, after);
    const order = compareStrings(old.id, current.id);
    before += order <= 0 ? 1 : 0;
    after += order >= 0 ? 1 : 0;
    if (order < 0) {
      removed.push(old.id);
    } else if (order > 0 || old !== current) {
      put.push(current);
    }
  }
  for (const item of previous.slice(before)) {
    removed.push(item.id);
  }
  return { put: put.concat(next.slice(after)), removed };
}
