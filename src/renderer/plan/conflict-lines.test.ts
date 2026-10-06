import { describe, expect, it } from 'vitest';
import type { Tag } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  workTask,
} from '../../core/testing/project-builder';
import { conflictLines, dateConflictLines } from './conflict-lines';

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

describe('dateConflictLines', () => {
  const WRITING = workTask('a', { name: 'Writing', deadline: at(2026, 9, 28, 12) });
  const DEFENSE = milestone('m', { name: 'Defense', mustFinishOn: at(2026, 9, 28, 10) });
  const LATE = project([WRITING, DEFENSE], [link('a', 'm')], {
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: true,
      baselineEnabled: false,
      alwaysShowPatterns: false,
    },
  });

  it('describes each date a task misses with its name, its end and the date', () => {
    const schedule = scheduleOrThrow(LATE);
    const end = schedule.placements.get('a')?.end;
    expect(end).toBe(at(2026, 9, 28, 17));
    expect(dateConflictLines(schedule, LATE)).toEqual([
      {
        conflict: { code: 'DEADLINE_MISSED', taskId: 'a' },
        taskName: 'Writing',
        end,
        date: at(2026, 9, 28, 12),
      },
      {
        conflict: { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'm' },
        taskName: 'Defense',
        end,
        date: at(2026, 9, 28, 10),
      },
    ]);
    expect(dateConflictLines(null, LATE)).toEqual([]);
  });

  it('lists the dates in the order of the task table, the conflicts of one task in the order of the schedule', () => {
    const both = workTask('z', {
      name: 'First',
      sortKey: '0',
      deadline: at(2026, 9, 28, 9),
      mustFinishOn: at(2026, 9, 28, 8),
    });
    const plan = { ...LATE, tasks: [...LATE.tasks, both] };
    const schedule = scheduleOrThrow(plan);
    expect(schedule.conflicts.map((conflict) => conflict.taskId)).toEqual(['a', 'm', 'z', 'z']);
    expect(
      dateConflictLines(schedule, plan).map((line) => [line.taskName, line.conflict.code]),
    ).toEqual([
      ['First', 'DEADLINE_MISSED'],
      ['First', 'MUST_FINISH_ON_NOT_MET'],
      ['Writing', 'DEADLINE_MISSED'],
      ['Defense', 'MUST_FINISH_ON_NOT_MET'],
    ]);
  });

  it('fails loudly on a conflict about a task it cannot describe', () => {
    const schedule = scheduleOrThrow(LATE);
    expect(() => dateConflictLines(schedule, { ...LATE, tasks: [DEFENSE] })).toThrow(
      'A conflict is about the unknown task a.',
    );
    expect(() => dateConflictLines({ ...schedule, placements: new Map() }, LATE)).toThrow(
      'The schedule has nothing for the task a of a conflict.',
    );
    expect(() => dateConflictLines({ ...schedule, wbsNumbers: new Map() }, LATE)).toThrow(
      'The schedule has nothing for the task a of a conflict.',
    );
    expect(() =>
      dateConflictLines(schedule, { ...LATE, tasks: [{ ...WRITING, deadline: null }, DEFENSE] }),
    ).toThrow('The task a has no date for its conflict DEADLINE_MISSED.');
    expect(() =>
      dateConflictLines(schedule, {
        ...LATE,
        tasks: [
          WRITING,
          { id: 'm', kind: 'summary', name: 'Defense', parentId: null, sortKey: 'm' },
        ],
      }),
    ).toThrow('The task m has no date for its conflict MUST_FINISH_ON_NOT_MET.');
  });
});
