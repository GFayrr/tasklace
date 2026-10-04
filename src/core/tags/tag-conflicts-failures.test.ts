import { describe, expect, it, vi } from 'vitest';
import { project, scheduleOrThrow, workTask } from '../testing/project-builder';

vi.mock('../scheduling/task-placement', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scheduling/task-placement')>();
  return {
    ...original,
    computePlacementSlots: () => ({ ok: false, error: 'INVALID_SEGMENTS' }),
  };
});

const PERSON = { id: 'p', name: 'Pat', color: '#336699', representsPersonOrTeam: true };

describe('tag conflicts of a placement whose slots cannot be computed', () => {
  it('throws instead of guessing the working time of the task', () => {
    const plan = project([workTask('a', { tagId: 'p', hoursPerDay: 2 })], [], { tags: [PERSON] });
    expect(() => scheduleOrThrow(plan)).toThrow(
      'The working slots of task a could not be computed: INVALID_SEGMENTS.',
    );
  });
});
