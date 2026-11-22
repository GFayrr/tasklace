import { describe, expect, it, vi } from 'vitest';
import { failure } from '../../core/result';
import { project, workTask } from '../../core/testing/project-builder';
import { createScheduleHost } from './schedule-host';
import { SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';

vi.mock('../plan/conflict-lines', async (importOriginal) => {
  const original = await importOriginal<typeof import('../plan/conflict-lines')>();
  return {
    ...original,
    describeConflicts: () => ({
      people: failure(Object.assign(new Error('Broken names'), { cause: () => 'unsendable' })),
      dates: failure(Symbol('unsendable')),
    }),
  };
});

describe('the description the schedule worker sends', () => {
  it('turns the errors of a description into plain errors the page can be sent, keeping their message', () => {
    const answer = createScheduleHost().answer({
      version: SCHEDULE_PROTOCOL_VERSION,
      generation: 1,
      kind: 'whole',
      project: project([workTask('a')]),
    });
    expect(structuredClone(answer.description)).toEqual({
      people: { kind: 'whole', lines: failure(new Error('Broken names')) },
      dates: { kind: 'whole', lines: failure(new Error('Symbol(unsendable)')) },
    });
  });
});
