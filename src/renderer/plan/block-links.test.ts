import { describe, expect, it } from 'vitest';
import type { Dependency } from '../../core/model/project';
import { blockLink, project, splitTask, workTask } from '../../core/testing/project-builder';
import { relinkBlocks } from './block-links';

const DEV = splitTask('dev', [
  [7, 0],
  [7, 0],
]);

/** Relinks the blocks of the split task of a project whose only block left is its first one. */
function keepFirstBlock(links: readonly Dependency[]) {
  const plan = project([DEV, workTask('x')], links);
  return relinkBlocks(plan, 'dev', (block) => (block === 0 ? 0 : null), 1);
}

describe('relinkBlocks', () => {
  it('merges a block link into the same whole-task link without losing anything', () => {
    const whole = blockLink('dev', 'x', {});
    const fromFirst = { ...blockLink('dev', 'x', { from: 0 }), id: 'dev_0-x' };
    const relinked = keepFirstBlock([whole, fromFirst]);
    expect(relinked.losesLink).toBe(false);
    expect(relinked.operations).toEqual([{ type: 'removeDependency', id: 'dev_0-x' }]);
    expect(relinked.links).toEqual([whole]);
  });

  it('tells that merging loses a link of another delay or another type', () => {
    const whole = blockLink('dev', 'x', {});
    const otherLag = { ...blockLink('dev', 'x', { from: 0 }), id: 'lag', lagHours: 2 };
    expect(keepFirstBlock([whole, otherLag]).losesLink).toBe(true);
    const otherType = { ...blockLink('dev', 'x', { from: 0 }, 'startToStart'), id: 'type' };
    expect(keepFirstBlock([whole, otherType]).losesLink).toBe(true);
  });

  it('removes the links of a block that is gone, and points the others at the whole task', () => {
    const fromSecond = blockLink('dev', 'x', { from: 1 });
    const intoFirst = blockLink('x', 'dev', { to: 0 });
    const relinked = keepFirstBlock([fromSecond, intoFirst]);
    expect(relinked.losesLink).toBe(false);
    expect(relinked.operations).toEqual([
      { type: 'removeDependency', id: fromSecond.id },
      { type: 'putDependency', dependency: { ...intoFirst, successorBlock: null } },
    ]);
  });
});
