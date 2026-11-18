import { compareStrings } from '../compare-strings';
import { valueAt } from '../table-value';
import type { Dependency, Project, Tag, Task } from '../model/project';

export interface Replacement<Item> {
  readonly previous: Item;
  readonly next: Item;
}

export interface ListChanges<Item> {
  readonly added: readonly Item[];
  readonly replaced: readonly Replacement<Item>[];
  readonly removed: readonly Item[];
}

export interface ProjectChanges {
  readonly header: boolean;
  readonly tasks: ListChanges<Task>;
  readonly dependencies: ListChanges<Dependency>;
  readonly tags: ListChanges<Tag>;
}

const LIST_KEYS: ReadonlySet<string> = new Set(['tasks', 'dependencies', 'tags']);

/** Lists what changed from one project of a session to the next: items added, replaced or removed, and whether a field of the header changed, comparing by identity so that an untouched list costs nothing and a touched one a single walk. */
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

/** Compares two lists sorted by identifier in one walk, giving the items only the second has, the items it holds as another object with their previous version, and the items only the first has. */
export function listChanges<Item extends { readonly id: string }>(
  previous: readonly Item[],
  next: readonly Item[],
): ListChanges<Item> {
  const added: Item[] = [];
  const replaced: Replacement<Item>[] = [];
  const removed: Item[] = [];
  if (previous === next) {
    return { added, replaced, removed };
  }
  let before = 0;
  let after = 0;
  while (before < previous.length && after < next.length) {
    const old = valueAt(previous, before);
    const current = valueAt(next, after);
    if (old === current) {
      before += 1;
      after += 1;
      continue;
    }
    const order = compareStrings(old.id, current.id);
    before += order <= 0 ? 1 : 0;
    after += order >= 0 ? 1 : 0;
    if (order < 0) {
      removed.push(old);
    } else if (order > 0) {
      added.push(current);
    } else if (old !== current) {
      replaced.push({ previous: old, next: current });
    }
  }
  return {
    added: added.concat(next.slice(after)),
    replaced,
    removed: removed.concat(previous.slice(before)),
  };
}
