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

/** Computes the schedule asked by a request of the current protocol version, ignoring any other message. */
export function answerScheduleRequest(message: unknown): ScheduleResponse | null {
  if (!isScheduleRequest(message)) {
    return null;
  }
  return {
    version: SCHEDULE_PROTOCOL_VERSION,
    generation: message.generation,
    result: scheduleProject(message.project),
  };
}

/** Tells whether a message is a schedule response of the current protocol version. */
export function isScheduleResponse(message: unknown): message is ScheduleResponse {
  return hasVersionAndGeneration(message) && 'result' in message;
}

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
