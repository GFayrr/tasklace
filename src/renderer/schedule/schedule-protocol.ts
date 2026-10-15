import type { Project } from '../../core/model/project';
import type { Result } from '../../core/result';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../core/scheduling/schedule-project';

export const SCHEDULE_PROTOCOL_VERSION = 1;

export interface ScheduleRequest {
  readonly version: typeof SCHEDULE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly project: Project;
}

export interface ScheduleResponse {
  readonly version: typeof SCHEDULE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly result: Result<Schedule, SchedulingFailure>;
}

/** Computes the schedule asked by a request of the current protocol version, throwing on any other message so that the worker fails and is replaced instead of leaving the computation waiting forever. */
export function answerScheduleRequest(message: unknown): ScheduleResponse {
  if (!isScheduleRequest(message)) {
    throw new Error('The schedule worker received a message that is not a schedule request.');
  }
  return {
    version: SCHEDULE_PROTOCOL_VERSION,
    generation: message.generation,
    result: scheduleProject(message.project),
  };
}

/** Tells whether a message is a schedule response of the current protocol version: a failure of a known kind, or a schedule with every field of its first level, the contents of its tables being trusted since the worker runs the code of this application. */
export function isScheduleResponse(message: unknown): message is ScheduleResponse {
  if (!hasVersionAndGeneration(message) || !('result' in message)) {
    return false;
  }
  const ok: unknown = Reflect.get(Object(message.result), 'ok');
  if (ok === false) {
    const error: unknown = Reflect.get(Object(message.result), 'error');
    const kind: unknown = Reflect.get(Object(error), 'kind');
    return typeof kind === 'string' && Object.hasOwn(FAILURE_KINDS, kind);
  }
  return ok === true && holdsSchedule(Reflect.get(Object(message.result), 'value'));
}

/** Tells whether a value holds every field of a schedule: its tables, its floats when computed, its conflicts and the report of its tags. */
function holdsSchedule(value: unknown): boolean {
  const floats: unknown = Reflect.get(Object(value), 'floats');
  const tagConflicts: unknown = Reflect.get(Object(value), 'tagConflicts');
  return (
    SCHEDULE_TABLES.every((table) => Reflect.get(Object(value), table) instanceof Map) &&
    (floats === null || floats instanceof Map) &&
    Array.isArray(Reflect.get(Object(value), 'conflicts')) &&
    Array.isArray(Reflect.get(Object(tagConflicts), 'conflicts')) &&
    Array.isArray(Reflect.get(Object(tagConflicts), 'tasksWithUnknownTag'))
  );
}

const SCHEDULE_TABLES = ['placements', 'summaries', 'wbsNumbers'] as const;
const FAILURE_KINDS = {
  calendar: true,
  startDate: true,
  structure: true,
  task: true,
} as const satisfies Readonly<Record<SchedulingFailure['kind'], true>>;

/** Tells whether a message is a schedule request of the current protocol version. */
function isScheduleRequest(message: unknown): message is ScheduleRequest {
  return hasVersionAndGeneration(message) && 'project' in message;
}

/** Tells whether a message carries the current protocol version and a whole generation number. */
function hasVersionAndGeneration(
  message: unknown,
): message is { readonly version: number; readonly generation: number } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'version' in message &&
    message.version === SCHEDULE_PROTOCOL_VERSION &&
    'generation' in message &&
    Number.isSafeInteger(message.generation)
  );
}
