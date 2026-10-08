import type { Dependency, Project, TaskId } from '../../core/model/project';
import { blockPairKey } from '../../core/scheduling/block-links';
import type { SharedOperation } from '../../core/shared/shared-operations';

export interface RelinkedBlocks {
  readonly operations: readonly SharedOperation[];
  readonly links: readonly Dependency[];
  readonly losesLink: boolean;
}

const FEWEST_SPLIT_BLOCKS = 2;

/** Lists the operations that renumber, remove or merge the links of the blocks of a task whose blocks only lost some or gained some at the end, telling whether a merge would lose a different link. */
export function relinkBlocks(
  project: Project,
  taskId: TaskId,
  newIndexOf: (oldIndex: number) => number | null,
  blockCount: number,
): RelinkedBlocks {
  const touching = project.dependencies
    .flatMap((link) => {
      const block = blockOn(link, taskId);
      return block === null ? [] : [{ link, block }];
    })
    .sort((left, right) => left.block - right.block);
  const links = project.dependencies.filter((link) => blockOn(link, taskId) === null);
  const kept = new Map(links.map((link) => [blockPairKey(link), link]));
  const removals: SharedOperation[] = [];
  const moves: SharedOperation[] = [];
  let losesLink = false;
  for (const { link, block } of touching) {
    const moved = movedLink(link, taskId, newIndexOf(block), blockCount);
    const twin = moved === null ? undefined : kept.get(blockPairKey(moved));
    if (moved === null || twin !== undefined) {
      losesLink ||= twin !== undefined && !sameEffect(twin, link);
      removals.push({ type: 'removeDependency', id: link.id });
      continue;
    }
    kept.set(blockPairKey(moved), moved);
    links.push(moved);
    if (moved !== link) {
      moves.push({ type: 'putDependency', dependency: moved });
    }
  }
  return { operations: [...removals, ...moves], links, losesLink };
}

/** Tells whether two links between the same tasks or blocks have the same type and lag, so that keeping one loses nothing. */
function sameEffect(left: Dependency, right: Dependency): boolean {
  return left.type === right.type && left.lagHours === right.lagHours;
}

/** Returns the block of a task a link names, or null when it names none of its blocks. */
function blockOn(link: Dependency, taskId: TaskId): number | null {
  if (link.predecessorId === taskId) {
    return link.predecessorBlock;
  }
  return link.successorId === taskId ? link.successorBlock : null;
}

/** Returns a link moved to the new number of the block of a task it names, or null when that block is gone. */
function movedLink(
  link: Dependency,
  taskId: TaskId,
  newIndex: number | null,
  blockCount: number,
): Dependency | null {
  if (newIndex === null) {
    return null;
  }
  const block = blockCount < FEWEST_SPLIT_BLOCKS ? null : newIndex;
  const current = blockOn(link, taskId);
  if (block === current) {
    return link;
  }
  return link.predecessorId === taskId
    ? { ...link, predecessorBlock: block }
    : { ...link, successorBlock: block };
}
