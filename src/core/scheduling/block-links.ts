import type { Dependency, Task, TaskId } from '../model/project';

/** Returns the number of blocks a task is scheduled in: one per block of a work task, one for a milestone, none for a summary. */
export function unitCountOf(task: Task): number {
  if (task.kind === 'summary') {
    return 0;
  }
  return task.kind === 'task' ? task.segments.length : 1;
}

/** Returns the block of its task a dependency leaves: the block it names, or the first block for a link from the start and the last block for a link from the end. */
export function predecessorBlockOf(
  dependency: Pick<Dependency, 'type' | 'predecessorBlock'>,
  unitCount: number,
): number {
  const fromStart = dependency.type === 'startToStart' || dependency.type === 'startToFinish';
  return dependency.predecessorBlock ?? (fromStart ? 0 : unitCount - 1);
}

/** Returns the block of its task a dependency leads to: the block it names, or the first block for a link to the start and the last block for a link to the end. */
export function successorBlockOf(
  dependency: Pick<Dependency, 'type' | 'successorBlock'>,
  unitCount: number,
): number {
  const toStart = dependency.type === 'finishToStart' || dependency.type === 'startToStart';
  return dependency.successorBlock ?? (toStart ? 0 : unitCount - 1);
}

/** Returns a dependency written in its shortest form, a named block that the whole task would stand for anyway becoming the whole task. */
export function shortestLink(
  dependency: Dependency,
  predecessor: Task,
  successor: Task,
): Dependency {
  const whole = { ...dependency, predecessorBlock: null, successorBlock: null };
  const predecessorBlock =
    dependency.predecessorBlock === predecessorBlockOf(whole, unitCountOf(predecessor))
      ? null
      : dependency.predecessorBlock;
  const successorBlock =
    dependency.successorBlock === successorBlockOf(whole, unitCountOf(successor))
      ? null
      : dependency.successorBlock;
  if (
    predecessorBlock === dependency.predecessorBlock &&
    successorBlock === dependency.successorBlock
  ) {
    return dependency;
  }
  return { ...dependency, predecessorBlock, successorBlock };
}

/** Tells whether a block reference names a block of a split work task, the whole task being always known. */
export function isKnownBlock(task: Task, block: number | null): boolean {
  if (block === null) {
    return true;
  }
  return task.kind === 'task' && task.segments.length > 1 && block < task.segments.length;
}

/** Returns a key that is the same for two dependencies joining the same tasks or blocks, in the same direction. */
export function blockPairKey(
  dependency: Pick<
    Dependency,
    'predecessorId' | 'successorId' | 'predecessorBlock' | 'successorBlock'
  >,
): string {
  return JSON.stringify([
    dependency.predecessorId,
    dependency.predecessorBlock,
    dependency.successorId,
    dependency.successorBlock,
  ]);
}

/** Returns a key naming one block of one task, or the whole task, the same for every participant. */
export function blockKey(taskId: TaskId, block: number | null): string {
  return JSON.stringify([taskId, block]);
}
