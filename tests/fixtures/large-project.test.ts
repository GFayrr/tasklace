import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileCalendar, type CompiledCalendar } from '../../src/core/calendar/compile-calendar';
import type { Project, Task } from '../../src/core/model/project';
import { computePlacementSlots, type Placement } from '../../src/core/scheduling/task-placement';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { readProject, STORED_VALUE_CODEC } from '../../src/core/validation/read-project';
import { LARGE_PROJECT_SEED, buildLargeProject } from './large-project';
import { createRandom } from './random';

const LARGE_PROJECT_FINGERPRINT =
  '6293639069451349d290768e94b6a820845c94e611e22092fd28a430baa4eb29';

const SCHEDULE_FINGERPRINT = 'b71829094294d71c788b9d903b0c23c845fc7e73e79a49a42bac98e461476bd6';
const ADVANCED_SCHEDULE_FINGERPRINT =
  'b6250c248af0492e06194741ea9a30db91968cbe019313ba7a41bf97e9563d8d';

/** Returns the SHA-256 fingerprint of a value serialized as JSON. */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('createRandom', () => {
  it('returns the same sequence for the same seed and numbers in [0, 1)', () => {
    const first = createRandom(42);
    const second = createRandom(42);
    const values = Array.from({ length: 1_000 }, () => first());
    expect(values).toEqual(Array.from({ length: 1_000 }, () => second()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('returns different sequences for different seeds', () => {
    expect(createRandom(1)()).not.toBe(createRandom(2)());
  });
});

describe('buildLargeProject', () => {
  it('generates 10,000 tasks and 20,000 dependencies', () => {
    const generated = buildLargeProject();
    expect(generated.tasks).toHaveLength(10_000);
    expect(generated.dependencies).toHaveLength(20_000);
  });

  it('generates a project that passes the complete validation unchanged', () => {
    const generated = buildLargeProject();
    const read = readProject(JSON.parse(JSON.stringify(generated)), STORED_VALUE_CODEC);
    expect(read).toEqual({ ok: true, value: generated });
  });

  it('generates exactly the same project on every machine for the fixed seed', () => {
    expect(fingerprint(buildLargeProject(LARGE_PROJECT_SEED))).toBe(LARGE_PROJECT_FINGERPRINT);
  });

  it('generates a different project for another seed', () => {
    expect(fingerprint(buildLargeProject(LARGE_PROJECT_SEED + 1))).not.toBe(
      LARGE_PROJECT_FINGERPRINT,
    );
  });
});

/** Returns a placement with the exact time slots of each block, as schedules used to carry them. */
function withSlots(calendar: CompiledCalendar, task: Task | undefined, placement: Placement) {
  if (task?.kind !== 'task') {
    return {
      ...placement,
      segments: placement.segments.map((segment) => ({ ...segment, slots: [] })),
    };
  }
  const slots = computePlacementSlots(calendar, task, placement);
  if (!slots.ok) {
    throw new Error(slots.error);
  }
  return {
    ...placement,
    segments: placement.segments.map((segment, index) => ({
      ...segment,
      slots: slots.value[index],
    })),
  };
}

/** Returns the fingerprint of the complete schedule of a project, maps being listed in their order and slots included. */
function scheduleFingerprint(input: Project): string {
  const schedule = scheduleProject(input);
  if (!schedule.ok) {
    throw new Error(JSON.stringify(schedule.error));
  }
  const { placements, summaries, wbsNumbers, floats, conflicts, tagConflicts } = schedule.value;
  const calendar = compileCalendar(input.calendar);
  if (!calendar.ok) {
    throw new Error(JSON.stringify(calendar.error));
  }
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  return fingerprint({
    placements: [...placements].map(([taskId, placement]) => [
      taskId,
      withSlots(calendar.value, tasksById.get(taskId), placement),
    ]),
    summaries: [...summaries],
    wbsNumbers: [...wbsNumbers],
    floats: floats === null ? null : [...floats],
    conflicts,
    tagConflicts,
  });
}

describe('large project schedule', () => {
  it('stays exactly the same, date by date and slot by slot', () => {
    expect(scheduleFingerprint(buildLargeProject())).toBe(SCHEDULE_FINGERPRINT);
  });

  it('stays exactly the same with the critical path and date constraints enabled', () => {
    const advanced = {
      ...buildLargeProject(),
      options: {
        criticalPathEnabled: true,
        dateConstraintsEnabled: true,
        alwaysShowPatterns: false,
      },
    };
    expect(scheduleFingerprint(advanced)).toBe(ADVANCED_SCHEDULE_FINGERPRINT);
  });
});
