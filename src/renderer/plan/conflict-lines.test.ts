import { describe, expect, it } from 'vitest';
import type { Tag } from '../../core/model/project';
import { project, scheduleOrThrow, workTask } from '../../core/testing/project-builder';
import { conflictLines } from './conflict-lines';

const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
const NEAR: Tag = { id: 'near', name: 'Near', color: '#4a3aa8', representsPersonOrTeam: true };
const PLAN = project(
  [
    workTask('a', { name: 'Interviews', tagId: 'near' }),
    workTask('b', { name: 'Analysis', tagId: 'near' }),
  ],
  [],
  { tags: [ALICE, NEAR] },
);

describe('conflictLines', () => {
  it('describes each conflict with its tag and the names of its tasks', () => {
    const schedule = scheduleOrThrow(PLAN);
    const [conflict] = schedule.tagConflicts.conflicts;
    expect(conflictLines(schedule, PLAN)).toEqual([
      {
        conflict,
        tagName: 'Near',
        color: '#4a3aa8',
        pattern: 'diagonal',
        taskNames: ['Interviews', 'Analysis'],
      },
    ]);
    expect(conflictLines(null, PLAN)).toEqual([]);
  });

  it('keeps a plain swatch when the colors cannot be compared', () => {
    const schedule = scheduleOrThrow(PLAN);
    const broken = { ...PLAN, tags: [ALICE, { ...NEAR, color: 'purple' }] };
    expect(conflictLines(schedule, broken)[0]?.pattern).toBeNull();
  });

  it('fails loudly on a conflict about a tag or a task the project does not have', () => {
    const schedule = scheduleOrThrow(PLAN);
    expect(() => conflictLines(schedule, { ...PLAN, tags: [ALICE] })).toThrow(
      'A conflict is about the unknown tag near.',
    );
    expect(() => conflictLines(schedule, { ...PLAN, tasks: PLAN.tasks.slice(1) })).toThrow(
      'A conflict is about the unknown task a.',
    );
  });
});
