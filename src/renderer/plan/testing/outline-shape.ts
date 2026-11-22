import type { Task, TaskId } from '../../../core/model/project';
import type { PlanOutline, PlanRow } from '../plan-outline';

export interface OutlineShape {
  readonly rows: readonly PlanRow[];
  readonly wbsById: ReadonlyMap<TaskId, string>;
  readonly rowIndexById: ReadonlyMap<TaskId, number>;
  readonly childrenById: ReadonlyMap<TaskId | null, readonly Task[]>;
}

/** Reads what an outline gives for every task and every parent of a list, as plain tables that tests can compare. */
export function outlineShape(outline: PlanOutline, tasks: readonly Task[]): OutlineShape {
  const wbsById = new Map<TaskId, string>();
  const rowIndexById = new Map<TaskId, number>();
  const childrenById = new Map<TaskId | null, readonly Task[]>();
  for (const parentId of new Set([null, ...tasks.map((task) => task.parentId)])) {
    const children = outline.childrenById.get(parentId);
    if (children !== undefined) {
      childrenById.set(parentId, children);
    }
  }
  for (const { id } of tasks) {
    const wbs = outline.wbsById.get(id);
    const row = outline.rowIndexById.get(id);
    expectAgreement(outline.wbsById.has(id), wbs !== undefined);
    expectAgreement(outline.rowIndexById.has(id), row !== undefined);
    if (wbs !== undefined) {
      wbsById.set(id, wbs);
    }
    if (row !== undefined) {
      rowIndexById.set(id, row);
    }
  }
  return { rows: outline.rows, wbsById, rowIndexById, childrenById };
}

/** Throws when a lookup tells it holds a task but gives nothing for it, or the other way round. */
function expectAgreement(has: boolean, gives: boolean): void {
  if (has !== gives) {
    throw new Error(
      'A lookup of the outline tells it holds a task it gives nothing for, or the other way round.',
    );
  }
}
