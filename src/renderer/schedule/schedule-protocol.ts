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

/** Tells whether a message is a schedule response of the current protocol version, whose result says whether it succeeded and, when it did, holds the tables of a schedule. */
export function isScheduleResponse(message: unknown): message is ScheduleResponse {
  if (!hasVersionAndGeneration(message) || !('result' in message)) {
    return false;
  }
  const ok: unknown = Reflect.get(Object(message.result), 'ok');
  return (
    ok === false ||
    (ok === true && holdsScheduleTables(Reflect.get(Object(message.result), 'value')))
  );
}

/** Tells whether a value holds the tables of a schedule that the table, the timeline and the CSV export read. */
function holdsScheduleTables(value: unknown): boolean {
  return SCHEDULE_TABLES.every((table) => Reflect.get(Object(value), table) instanceof Map);
}

const SCHEDULE_TABLES = ['placements', 'summaries', 'wbsNumbers'] as const;

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
