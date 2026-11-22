import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import { valueAt } from '../../core/table-value';
import { link, summary, testId, workTask } from '../../core/testing/project-builder';
import {
  buildPlanOutline,
  groupIncoming,
  NOTHING_COLLAPSED,
  nextIncoming,
  type IncomingBasis,
  nextPlanOutline,
  taskIdOfNumber,
  toggledSummary,
  type PlanOutline,
} from './plan-outline';
import { outlineShape } from './testing/outline-shape';

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

/** Reads an outline and the outline a full build gives, for the same tasks, as comparable tables, and finds each task again by its number. */
function expectBuilt(outline: PlanOutline, tasks: readonly Task[], collapsed: ReadonlySet<TaskId>) {
  const shape = outlineShape(outline, tasks);
  expect(shape).toEqual(outlineShape(buildPlanOutline(tasks, collapsed), tasks));
  const numbered = [...shape.wbsById];
  expect(numbered.map(([, wbs]) => taskIdOfNumber(outline, wbs))).toEqual(
    numbered.map(([id]) => id),
  );
  expect(taskIdOfNumber(outline, '0')).toBeUndefined();
}

interface Shape {
  readonly present: boolean;
  readonly parent: string | null;
  readonly sortKey: string;
}

describe('nextPlanOutline', () => {
  /** Builds a new basis on the tasks, since a basis shares its records with the ones made from it. */
  const fresh = (collapsed: ReadonlySet<TaskId> = NOTHING_COLLAPSED) =>
    nextPlanOutline(null, TASKS, collapsed);

  it('builds the outline the first time and gives the same one back when neither the tasks nor the collapsed summaries changed', () => {
    const basis = fresh();
    expectBuilt(basis.outline, TASKS, NOTHING_COLLAPSED);
    expect(nextPlanOutline(basis, TASKS, NOTHING_COLLAPSED)).toBe(basis);
  });

  it('swaps renamed tasks into the outline, shown or hidden, without numbering again and keeping the other rows', () => {
    const collapsed = new Set([testId('p')]);
    const folded = fresh(collapsed);
    const generation = folded.table.generation;
    const tasks = replacing(TASKS, { ...second, name: 'Renamed' }, { ...alone, name: 'Moved on' });
    const next = nextPlanOutline(folded, tasks, collapsed);
    expectBuilt(next.outline, tasks, collapsed);
    expect(next.table.generation).toBe(generation);
    expect(next.outline.rows[0]).toBe(folded.outline.rows[0]);
  });

  it('keeps the table from numbers to tasks already built, which still holds since no number changed', () => {
    const basis = fresh();
    expect(taskIdOfNumber(basis.outline, '1.2')).toBe(second.id);
    const next = nextPlanOutline(
      basis,
      replacing(TASKS, { ...second, name: 'Renamed' }),
      NOTHING_COLLAPSED,
    );
    expect(taskIdOfNumber(next.outline, '1.2')).toBe(second.id);
    expect(taskIdOfNumber(next.outline, '2')).toBe(alone.id);
  });

  it('numbers again when a task moves, arrives or leaves, or when a summary is opened or closed, an older outline then giving no number at all', () => {
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
      const basis = fresh();
      const generation = basis.table.generation;
      const next = nextPlanOutline(basis, tasks, folded);
      expectBuilt(next.outline, tasks, folded);
      expect(next.table.generation).toBe(generation + 1);
      expect([
        basis.outline.wbsById.has(first.id),
        basis.outline.rowIndexById.get(first.id),
      ]).toEqual([false, undefined]);
    }
  });

  it('leaves alone the groups no task joins or leaves, and every group when only a summary is opened or closed', () => {
    const basis = fresh();
    const underParent = basis.table.groups.get(parent.id);
    const children = [...(underParent ?? [])];
    const grown = nextPlanOutline(
      basis,
      [...TASKS, workTask('r', { sortKey: 'k0' })],
      NOTHING_COLLAPSED,
    );
    expect(grown.table.groups.get(parent.id)).toBe(underParent);
    expect(grown.table.groups.get(parent.id)).toEqual(children);
    const groups = [...grown.table.groups.values()];
    const folded = nextPlanOutline(grown, grown.tasks, new Set([parent.id]));
    expect(
      [...folded.table.groups.values()].map((group, index) => group === groups[index]),
    ).toEqual(groups.map(() => true));
  });

  it('gives the outline a full build gives when a list becomes another at once, few or many tasks changing', () => {
    const ids = Array.from(
      { length: 90 },
      (_unused, index) => `t${String(index).padStart(2, '0')}`,
    );
    const shape = fc.record({
      present: fc.boolean(),
      parent: fc.constantFrom(null, 't00', 't01', 't02'),
      sortKey: fc.constantFrom(...SORT_KEYS),
    });
    /** Makes the task of an identifier in a shape, or nothing when the shape leaves it out. */
    const taskOf = (id: string, { present, parent: parentId, sortKey }: Shape) =>
      present
        ? [workTask(id, { parentId: parentId === null ? null : testId(parentId), sortKey })]
        : [];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(shape, shape), { minLength: ids.length, maxLength: ids.length }),
        fc.nat({ max: ids.length }),
        fc.subarray(ids.slice(0, 3).map((id) => testId(id))),
        (shapes, changing, folded) => {
          const pairs = ids.map((id, index) => {
            const [before, after] = valueAt(shapes, index);
            const old = taskOf(id, before);
            return [old, index < changing ? taskOf(id, after) : old] as const;
          });
          const collapsed = new Set(folded);
          const after = pairs.flatMap(([, next]) => next);
          const basis = nextPlanOutline(
            null,
            pairs.flatMap(([old]) => old),
            collapsed,
          );
          expectBuilt(nextPlanOutline(basis, after, collapsed).outline, after, collapsed);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('gives the outline a full build gives after a sequence of steps that place tasks one by one or sort their groups again, on the same records', () => {
    const ids = Array.from(
      { length: 80 },
      (_unused, index) => `t${String(index).padStart(2, '0')}`,
    );
    const shape = fc.record({
      present: fc.boolean(),
      parent: fc.constantFrom(null, 't00', 't01', 't02'),
      sortKey: fc.constantFrom(...SORT_KEYS),
    });
    const step = fc.record({
      shapes: fc.array(shape, { minLength: ids.length, maxLength: ids.length }),
      changing: fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 70, max: ids.length })),
      offset: fc.nat({ max: ids.length - 1 }),
    });
    /** Makes the task of an identifier in a shape, or nothing when the shape leaves it out. */
    const taskOf = (id: string, { present, parent: parentId, sortKey }: Shape) =>
      present
        ? [workTask(id, { parentId: parentId === null ? null : testId(parentId), sortKey })]
        : [];
    fc.assert(
      fc.property(fc.array(step, { minLength: 2, maxLength: 6 }), (steps) => {
        let tasks: readonly Task[] = [];
        let current = nextPlanOutline(null, tasks, NOTHING_COLLAPSED);
        for (const { shapes, changing, offset } of steps) {
          const changed = new Set(
            Array.from({ length: changing }, (_unused, index) => (offset + index) % ids.length),
          );
          tasks = ids.flatMap((id, index) =>
            changed.has(index)
              ? taskOf(id, valueAt(shapes, index))
              : tasks.filter((task) => task.id === testId(id)),
          );
          current = nextPlanOutline(current, tasks, NOTHING_COLLAPSED);
          expectBuilt(current.outline, tasks, NOTHING_COLLAPSED);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('takes the tasks out of the group they leave when many tasks change at once, even if nothing else touches that group, forgetting it once empty', () => {
    const roots = Array.from({ length: 70 }, (_unused, index) =>
      workTask(`r${String(index).padStart(2, '0')}`, { sortKey: 'k1' }),
    );
    const before = [parent, first, second, ...roots];
    const after = [
      parent,
      { ...first, parentId: null },
      { ...second, parentId: null },
      ...roots.map((task) => ({ ...task, sortKey: 'k2' })),
    ].sort((left, right) => (left.id < right.id ? -1 : 1));
    const next = nextPlanOutline(
      nextPlanOutline(null, before, NOTHING_COLLAPSED),
      after,
      NOTHING_COLLAPSED,
    );
    expectBuilt(next.outline, after, NOTHING_COLLAPSED);
    expect(next.outline.childrenById.get(parent.id)).toBeUndefined();
  });

  it('refuses an older outline once a newer one changed the records they share, even for the same tasks', () => {
    const basis = fresh();
    nextPlanOutline(basis, replacing(TASKS, { ...second, name: 'Renamed' }), NOTHING_COLLAPSED);
    for (const [tasks, collapsed] of [
      [TASKS, NOTHING_COLLAPSED],
      [TASKS, new Set([parent.id])],
    ] as const) {
      expect(() => nextPlanOutline(basis, tasks, collapsed)).toThrow(
        'An outline was given after a newer one had changed the records they share.',
      );
    }
  });

  it('refuses a basis whose records it did not make, since it changes only its own in place', () => {
    const basis = fresh();
    expect(() =>
      nextPlanOutline(
        { ...basis, table: { ...basis.table } },
        replacing(TASKS, { ...second, name: 'Renamed' }),
        NOTHING_COLLAPSED,
      ),
    ).toThrow('This table was not made by the outline of the plan.');
  });

  it('fails loudly when the records do not hold a replaced task', () => {
    const empty = nextPlanOutline(null, [], NOTHING_COLLAPSED);
    Object.assign(empty.table, { reflects: TASKS });
    expect(() =>
      nextPlanOutline(
        { ...empty, tasks: TASKS },
        replacing(TASKS, { ...second, name: 'Renamed' }),
        NOTHING_COLLAPSED,
      ),
    ).toThrow(`The outline holds no record of the task ${second.id}.`);
    const blank = nextPlanOutline(null, [], NOTHING_COLLAPSED);
    Object.assign(blank.table, { reflects: TASKS });
    expect(() =>
      nextPlanOutline(
        { ...blank, tasks: TASKS },
        replacing(TASKS, { ...second, sortKey: 'k2' }),
        NOTHING_COLLAPSED,
      ),
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
          expectBuilt(current.outline, tasks, collapsed);
        }
      }),
    );
  });
});

/** Checks that a grouping holds and gives for every task what a full grouping of the dependencies gives. */
function expectGrouped(basis: IncomingBasis, dependencies: readonly Dependency[]): void {
  const full = groupIncoming(dependencies);
  expect(basis.table.groups).toEqual(full);
  for (const id of [...IDS, 'none']) {
    expect(basis.incoming.get(testId(id))).toEqual(full.get(testId(id)));
  }
}

describe('nextIncoming', () => {
  const DEPENDENCIES: readonly [Dependency, Dependency, Dependency] = [
    link('a', 'c'),
    link('b', 'c'),
    link('c', 'd'),
  ];
  const basis = nextIncoming(null, DEPENDENCIES);

  it('groups the dependencies the first time and gives the same grouping back for the same list', () => {
    expectGrouped(basis, DEPENDENCIES);
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
      expectGrouped(nextIncoming(nextIncoming(null, DEPENDENCIES), dependencies), dependencies);
    }
    const before = nextIncoming(null, DEPENDENCIES);
    const listOfC = before.incoming.get(testId('c'));
    const kept = nextIncoming(before, [toC, otherToC, { ...toD, lagHours: 2 }]);
    expect(kept.incoming.get(testId('c'))).toBe(listOfC);
    expect(kept.table).toBe(before.table);
  });

  it('refuses a grouping whose table it did not make', () => {
    const own = nextIncoming(null, DEPENDENCIES);
    expect(() => nextIncoming({ ...own, table: { ...own.table } }, DEPENDENCIES.slice(1))).toThrow(
      'This table was not made by the outline of the plan.',
    );
  });

  it('refuses an older grouping once a newer one changed the table they share', () => {
    const first = nextIncoming(null, DEPENDENCIES);
    nextIncoming(first, DEPENDENCIES.slice(1));
    for (const dependencies of [DEPENDENCIES.slice(2), DEPENDENCIES]) {
      expect(() => nextIncoming(first, dependencies)).toThrow(
        'A grouping of the dependencies was given after a newer one had changed its table.',
      );
    }
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
          expectGrouped(current, dependencies);
        }
      }),
    );
  });
});
