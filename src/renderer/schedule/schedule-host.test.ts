import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { unwrap } from '../../core/testing/arbitraries';
import { project, workTask } from '../../core/testing/project-builder';
import { describeConflicts } from '../plan/conflict-lines';
import { descriptionDeltaOf, projectDeltaOf } from './schedule-changes';
import { createScheduleHost } from './schedule-host';
import { SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';

const FIRST = project([workTask('a'), workTask('b')]);
const SECOND = { ...FIRST, tasks: [workTask('a'), { ...workTask('b'), name: 'Renamed' }] };
const BROKEN: Project = { ...FIRST, startDate: Number.NaN };

/** Writes a request for a whole project. */
function whole(generation: number, sent: Project) {
  return { version: SCHEDULE_PROTOCOL_VERSION, generation, kind: 'whole', project: sent };
}

/** Writes a request for the changes from one project to another, based on a generation. */
function changes(generation: number, basis: number, before: Project, after: Project) {
  return {
    version: SCHEDULE_PROTOCOL_VERSION,
    generation,
    kind: 'changes',
    basis,
    changes: projectDeltaOf(before, after),
  };
}

describe('createScheduleHost', () => {
  it('answers a whole project with a whole schedule, then changes with what changed, describing the conflicts each time', () => {
    const host = createScheduleHost();
    const first = host.answer(whole(1, FIRST));
    expect(first).toEqual({
      version: SCHEDULE_PROTOCOL_VERSION,
      generation: 1,
      result: { ok: true, value: { kind: 'whole', schedule: unwrap(scheduleProject(FIRST)) } },
      description: descriptionDeltaOf(
        null,
        describeConflicts(unwrap(scheduleProject(FIRST)), FIRST),
      ),
    });
    const second = host.answer(changes(2, 1, FIRST, SECOND));
    expect(second.generation).toBe(2);
    expect(second.result).toEqual({
      ok: true,
      value: {
        kind: 'changes',
        changes: {
          placements: { put: [], removed: [] },
          summaries: { put: [], removed: [] },
          wbsNumbers: { put: [], removed: [] },
          floats: { kind: 'same' },
          conflicts: null,
          tagConflicts: null,
        },
      },
    });
  });

  it('gives the failure of a project it cannot schedule, then the next schedule whole', () => {
    const host = createScheduleHost();
    host.answer(whole(1, FIRST));
    const failed = host.answer(changes(2, 1, FIRST, BROKEN));
    expect(failed.result).toEqual({ ok: false, error: { kind: 'startDate' } });
    expect(failed.description).toEqual({
      people: { kind: 'changes', length: 0, put: [] },
      dates: { kind: 'changes', length: 0, put: [] },
    });
    const next = host.answer(changes(3, 2, BROKEN, SECOND));
    expect(next.result.ok && next.result.value.kind).toBe('whole');
  });

  it('answers a whole project whole even after a schedule it already gave', () => {
    const host = createScheduleHost();
    host.answer(whole(1, FIRST));
    const again = host.answer(whole(2, SECOND));
    expect(again.result.ok && again.result.value.kind).toBe('whole');
  });

  it('fails on changes that do not follow the project it holds, and on anything but a request', () => {
    const host = createScheduleHost();
    expect(() => host.answer(changes(1, 0, FIRST, SECOND))).toThrow(
      'The schedule worker received changes to the request 0 it does not hold.',
    );
    host.answer(whole(1, FIRST));
    expect(() => host.answer(changes(2, 7, FIRST, SECOND))).toThrow(
      'The schedule worker received changes to the request 7 it does not hold.',
    );
    const refusal = 'The schedule worker received a message that is not a schedule request.';
    for (const message of [
      null,
      { ...whole(3, FIRST), version: 1 },
      { ...whole(3, FIRST), generation: 1.5 },
      { ...whole(3, FIRST), project: null },
      { ...whole(3, FIRST), kind: 'other' },
      { ...changes(3, 1, FIRST, SECOND), basis: 'one' },
      { ...changes(3, 1, FIRST, SECOND), changes: null },
    ]) {
      expect(() => host.answer(message)).toThrow(refusal);
    }
    expect(host.answer(changes(3, 1, FIRST, SECOND)).generation).toBe(3);
  });
});
