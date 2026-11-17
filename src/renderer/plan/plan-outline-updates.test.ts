import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import { link, summary, testId, workTask } from '../../core/testing/project-builder';
import {
  buildPlanOutline,
  groupIncoming,
  NOTHING_COLLAPSED,
  nextIncoming,
  nextPlanOutline,
  taskIdOfNumber,
  toggledSummary,
} from './plan-outline';

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const SORT_KEYS = ['k0', 'k1', 'k2'] as const;

const parent = summary('p', { sortKey: 'k0' });
const first = workTask('p1', { parentId: testId('p'), sortKey: 'k0' });
const second = workTask('p2', { parentId: testId('p'), sortKey: 'k1' });
const alone = workTask('q', { sortKey: 'k1' });
const TASKS: readonly Task[] = [parent, first, second, alone];

/** Returns the tasks with the ones of the same identifier replaced, keeping them sorted by identifier as a project does. */
function replacing(tasks: readonly Task[], ...replacements: readonly Task[]): readonly Task[] {
  return tasks.map((task) => replacements.find((next) => next.id === task.id) ?? task);
}

describe('nextPlanOutline', () => {
  const basis = nextPlanOutline(null, TASKS, NOTHING_COLLAPSED);

  it('builds the outline the first time and gives the same one back when neither the tasks nor the collapsed summaries changed', () => {
    expect(basis.outline).toEqual(buildPlanOutline(TASKS, NOTHING_COLLAPSED));
    expect(nextPlanOutline(basis, TASKS, NOTHING_COLLAPSED)).toBe(basis);
  });

  it('swaps renamed tasks into the outline, shown or hidden, keeping its numbers, its row indices and the other rows', () => {
    const collapsed = new Set([testId('p')]);
    const folded = nextPlanOutline(null, TASKS, collapsed);
    const tasks = replacing(TASKS, { ...second, name: 'Renamed' }, { ...alone, name: 'Moved on' });
    const next = nextPlanOutline(folded, tasks, collapsed);
    expect(next.outline).toEqual(buildPlanOutline(tasks, collapsed));
    expect([next.outline.wbsById, next.outline.rowIndexById, next.outline.rows[0]]).toEqual([
      folded.outline.wbsById,
      folded.outline.rowIndexById,
      folded.outline.rows[0],
    ]);
    expect(next.outline.wbsById).toBe(folded.outline.wbsById);
    expect(next.outline.rowIndexById).toBe(folded.outline.rowIndexById);
    expect(next.outline.rows[0]).toBe(folded.outline.rows[0]);
  });

  it('keeps the table from numbers to tasks already built, which still holds since no number changed', () => {
    expect(taskIdOfNumber(basis.outline, '1.2')).toBe(second.id);
    const next = nextPlanOutline(
      basis,
      replacing(TASKS, { ...second, name: 'Renamed' }),
      NOTHING_COLLAPSED,
    );
    expect(taskIdOfNumber(next.outline, '1.2')).toBe(second.id);
    expect(taskIdOfNumber(next.outline, '2')).toBe(alone.id);
  });

  it('builds the outline again when a task moves, arrives or leaves, or when a summary is opened or closed', () => {
    const moved = replacing(TASKS, { ...first, sortKey: 'k2' });
    const reparented = replacing(TASKS, { ...alone, parentId: testId('p') });
    const added = [...TASKS, workTask('r', { sortKey: 'k0' })];
    const removed = TASKS.filter((task) => task !== second);
    const collapsed = new Set([testId('p')]);
    const cases: readonly [readonly Task[], ReadonlySet<TaskId>][] = [
      [moved, NOTHING_COLLAPSED],
      [reparented, NOTHING_COLLAPSED],
      [added, NOTHING_COLLAPSED],
      [removed, NOTHING_COLLAPSED],
      [TASKS, collapsed],
    ];
    for (const [tasks, folded] of cases) {
      const next = nextPlanOutline(basis, tasks, folded);
      expect(next.outline).toEqual(buildPlanOutline(tasks, folded));
      expect(next.outline.wbsById).not.toBe(basis.outline.wbsById);
    }
  });

  it('fails loudly when the earlier outline does not hold a replaced task among the children of its parent', () => {
    const wrong = {
      tasks: TASKS,
      collapsed: NOTHING_COLLAPSED,
      outline: buildPlanOutline([], NOTHING_COLLAPSED),
    };
    expect(() =>
      nextPlanOutline(wrong, replacing(TASKS, { ...second, name: 'Renamed' }), NOTHING_COLLAPSED),
    ).toThrow(`The task ${second.id} is not among the children of its parent.`);
  });

  it('gives after any sequence of changes the outline a full build gives', () => {
    const change = fc.record({
      id: fc.constantFrom(...IDS),
      kind: fc.constantFrom('put', 'remove', 'rename', 'move', 'fold'),
      parent: fc.constantFrom(null, ...IDS),
      sortKey: fc.constantFrom(...SORT_KEYS),
    });
    fc.assert(
      fc.property(fc.array(change, { maxLength: 30 }), (changes) => {
        let tasks: readonly Task[] = [];
        let collapsed: ReadonlySet<TaskId> = NOTHING_COLLAPSED;
        let current = nextPlanOutline(null, tasks, collapsed);
        for (const { id, kind, parent: parentId, sortKey } of changes) {
          const task = tasks.find((candidate) => candidate.id === testId(id));
          const placed = { parentId: parentId === null ? null : testId(parentId), sortKey };
          if (kind === 'fold') {
            collapsed = toggledSummary(collapsed, testId(id));
          } else if (kind === 'remove' || (kind === 'put' && task !== undefined)) {
            tasks = tasks.filter((other) => other !== task);
          } else if (kind === 'put') {
            tasks = [...tasks, workTask(id, placed)].sort((left, right) =>
              left.id < right.id ? -1 : 1,
            );
          } else if (task !== undefined) {
            tasks = replacing(
              tasks,
              kind === 'rename' ? { ...task, name: `${task.name}!` } : { ...task, ...placed },
            );
          }
          current = nextPlanOutline(current, tasks, collapsed);
          expect(current.outline).toEqual(buildPlanOutline(tasks, collapsed));
        }
      }),
    );
  });
});

describe('nextIncoming', () => {
  const DEPENDENCIES: readonly [Dependency, Dependency, Dependency] = [
    link('a', 'c'),
    link('b', 'c'),
    link('c', 'd'),
  ];
  const basis = nextIncoming(null, DEPENDENCIES);

  it('groups the dependencies the first time and gives the same grouping back for the same list', () => {
    expect(basis.incoming).toEqual(groupIncoming(DEPENDENCIES));
    expect(nextIncoming(basis, DEPENDENCIES)).toBe(basis);
  });

  it('groups again only the tasks a changed dependency leads to, forgetting a task nothing leads to any more', () => {
    const [toC, otherToC, toD] = DEPENDENCIES;
    const cases: readonly (readonly Dependency[])[] = [
      [toC, otherToC],
      [toC, { ...otherToC, lagHours: 4 }, toD],
      [{ ...toC, successorId: testId('d') }, otherToC, toD],
      [link('a', 'b'), toC, otherToC, toD],
    ];
    for (const dependencies of cases) {
      const next = nextIncoming(basis, dependencies);
      expect(next.incoming).toEqual(groupIncoming(dependencies));
    }
    const kept = nextIncoming(basis, [toC, otherToC, { ...toD, lagHours: 2 }]);
    expect(kept.incoming.get(testId('c'))).toBe(basis.incoming.get(testId('c')));
  });

  it('gives after any sequence of changes the grouping a full grouping gives', () => {
    const change = fc.record({
      predecessor: fc.constantFrom(...IDS),
      successor: fc.constantFrom(...IDS),
      kind: fc.constantFrom('toggle', 'lag'),
    });
    fc.assert(
      fc.property(fc.array(change, { maxLength: 30 }), (changes) => {
        let dependencies: readonly Dependency[] = [];
        let current = nextIncoming(null, dependencies);
        for (const { predecessor, successor, kind } of changes) {
          const made = link(predecessor, successor);
          const found = dependencies.find((dependency) => dependency.id === made.id);
          if (found === undefined) {
            dependencies = [...dependencies, made].sort((left, right) =>
              left.id < right.id ? -1 : 1,
            );
          } else {
            dependencies =
              kind === 'toggle'
                ? dependencies.filter((dependency) => dependency !== found)
                : dependencies.map((dependency) =>
                    dependency === found ? { ...found, lagHours: found.lagHours + 1 } : dependency,
                  );
          }
          current = nextIncoming(current, dependencies);
          expect(current.incoming).toEqual(groupIncoming(dependencies));
        }
      }),
    );
  });
});
