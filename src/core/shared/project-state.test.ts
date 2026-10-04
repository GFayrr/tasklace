import { describe, expect, it } from 'vitest';
import { link, project, workTask } from '../testing/project-builder';
import { closesCycle, createProjectState } from './project-state';

describe('closesCycle', () => {
  it('counts a link from or to a task missing from the state as a loop, so that nothing doubtful is accepted', () => {
    const state = createProjectState(project([workTask('a'), workTask('b')]));
    expect(closesCycle(state, link('a', 'gone'))).toBe(true);
    expect(closesCycle(state, link('gone', 'b'))).toBe(true);
    expect(closesCycle(state, link('a', 'b'))).toBe(false);
  });

  it('finds the loop a link would close back to the task it leaves', () => {
    const state = createProjectState(project([workTask('a'), workTask('b')], [link('a', 'b')]));
    expect(closesCycle(state, link('b', 'a'))).toBe(true);
  });
});
