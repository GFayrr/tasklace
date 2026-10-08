import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeWbsNumbers } from '../../core/scheduling/wbs';
import {
  blockLink,
  link,
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import {
  buildPlanOutline,
  groupIncoming,
  predecessorText,
  taskIdOfNumber,
  toggledSummary,
  withAncestorsOpen,
} from './plan-outline';

const TASKS = [
  summary('s', { sortKey: 'a' }),
  workTask('s1', { parentId: 's', sortKey: 'b' }),
  workTask('s0', { parentId: 's', sortKey: 'a' }),
  summary('t', { sortKey: 'b' }),
  summary('t1', { parentId: 't', sortKey: 'a' }),
  milestone('t11', { parentId: 't1', sortKey: 'a' }),
  workTask('u', { sortKey: 'c' }),
];

describe('buildPlanOutline', () => {
  it('lists the tasks in tree order with their WBS number and depth', () => {
    const outline = buildPlanOutline(TASKS, new Set());
    expect(outline.rows.map((row) => [row.task.id, row.wbs, row.depth])).toEqual([
      ['s', '1', 0],
      ['s0', '1.1', 1],
      ['s1', '1.2', 1],
      ['t', '2', 0],
      ['t1', '2.1', 1],
      ['t11', '2.1.1', 2],
      ['u', '3', 0],
    ]);
    expect(outline.rows.map((row) => row.hasChildren)).toEqual([
      true,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(outline.rowIndexById.get('u')).toBe(6);
  });

  it('hides the descendants of a collapsed summary but keeps their numbers', () => {
    const outline = buildPlanOutline(TASKS, new Set(['t', 'u']));
    expect(outline.rows.map((row) => row.task.id)).toEqual(['s', 's0', 's1', 't', 'u']);
    expect(outline.rows.find((row) => row.task.id === 't')?.collapsed).toBe(true);
    expect(outline.rows.find((row) => row.task.id === 'u')?.collapsed).toBe(false);
    expect(outline.wbsById.get('t11')).toBe('2.1.1');
    expect(outline.rowIndexById.has('t11')).toBe(false);
  });

  it('numbers tasks exactly as the schedule does, both ways, whatever their order and the summaries collapsed', () => {
    const summaries = TASKS.filter((task) => task.kind === 'summary').map((task) => task.id);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(TASKS, { minLength: TASKS.length }),
        fc.subarray(summaries),
        (shuffled, collapsed) => {
          const outline = buildPlanOutline(shuffled, new Set(collapsed));
          const grouped = new Map<string | null, typeof TASKS>();
          shuffled.forEach((task) => {
            grouped.set(task.parentId, [...(grouped.get(task.parentId) ?? []), task]);
          });
          expect(outline.wbsById).toEqual(computeWbsNumbers(grouped));
          for (const [id, wbs] of outline.wbsById) {
            expect(taskIdOfNumber(outline, wbs)).toBe(id);
          }
          expect(taskIdOfNumber(outline, '99')).toBeUndefined();
          expect(outline.rows.map((row) => row.task.id)).toEqual(
            buildPlanOutline(TASKS, new Set(collapsed)).rows.map((row) => row.task.id),
          );
        },
      ),
    );
  });
});

describe('predecessorText', () => {
  it('writes the predecessors of each task by WBS number, as in the CSV table', () => {
    const plan = project(
      [workTask('a'), workTask('b'), workTask('c')],
      [link('b', 'c', 'startToStart', 2), link('a', 'c')],
    );
    const outline = buildPlanOutline(plan.tasks, new Set());
    const incoming = groupIncoming(plan.dependencies);
    expect(predecessorText(incoming.get('c'), outline.wbsById)).toBe('1, 2SS+2h');
    expect(predecessorText(incoming.get('a'), outline.wbsById)).toBe('');
  });

  it('writes the links to the whole task apart from those to one block, by task then by block', () => {
    const plan = project(
      [
        splitTask('a', [
          [2, 0],
          [2, 0],
          [2, 0],
        ]),
        splitTask('b', [
          [2, 0],
          [2, 0],
        ]),
      ],
      [
        blockLink('a', 'b', { from: 1, to: 1 }, 'startToStart'),
        blockLink('a', 'b', { to: 1 }),
        blockLink('a', 'b', { from: 0, to: 1 }, 'startToFinish'),
        blockLink('a', 'b', {}, 'startToStart'),
      ],
    );
    const outline = buildPlanOutline(plan.tasks, new Set());
    const incoming = groupIncoming(plan.dependencies).get('b');
    expect(predecessorText(incoming, outline.wbsById)).toBe('1SS');
    expect(predecessorText(incoming, outline.wbsById, 1)).toBe('1, 1#1SF, 1#2SS');
    expect(predecessorText(incoming, outline.wbsById, 0)).toBe('');
  });
});

describe('toggledSummary', () => {
  it('closes an open summary and opens a closed one, leaving the others', () => {
    const closed = toggledSummary(new Set(['a']), 'b');
    expect([...closed].sort()).toEqual(['a', 'b']);
    expect([...toggledSummary(closed, 'a')]).toEqual(['b']);
  });
});

describe('withAncestorsOpen', () => {
  it('opens every summary above a task, keeping the others and the same set when none hides it', () => {
    const collapsed = new Set(['t', 't1', 's']);
    expect([...withAncestorsOpen(collapsed, TASKS, 't11')]).toEqual(['s']);
    expect(withAncestorsOpen(collapsed, TASKS, 'u')).toBe(collapsed);
    expect(withAncestorsOpen(collapsed, TASKS, 'gone')).toBe(collapsed);
  });
});
