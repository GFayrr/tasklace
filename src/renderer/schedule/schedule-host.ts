import type { Project } from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { scheduleProject, type Schedule } from '../../core/scheduling/schedule-project';
import { describeConflicts, type ConflictDescription } from '../plan/conflict-lines';
import { descriptionDeltaOf, projectAfterDelta, scheduleDeltaOf } from './schedule-changes';
import { packedBuffers } from './packed-schedule';
import {
  isScheduleRequest,
  SCHEDULE_PROTOCOL_VERSION,
  type ScheduleAnswer,
  type ScheduleRequest,
  type ScheduleResponse,
} from './schedule-protocol';

export interface ScheduleHost {
  readonly answer: (message: unknown) => ScheduleResponse;
}

interface Held {
  readonly generation: number;
  readonly project: Project;
}

/** Keeps, in the schedule worker, the project the page sent and the last schedule and conflicts, so that each request carries only what changed and each answer gives only what changed, conflicts being described here. */
export function createScheduleHost(): ScheduleHost {
  let held: Held | null = null;
  let previous: Schedule | null = null;
  let described: ConflictDescription | null = null;
  return {
    answer: (message) => {
      if (!isScheduleRequest(message)) {
        throw new Error('The schedule worker received a message that is not a schedule request.');
      }
      const project = projectOf(message, held);
      held = { generation: message.generation, project };
      const result = scheduleProject(project);
      const before = message.kind === 'whole' ? null : previous;
      previous = result.ok ? result.value : null;
      const description = sendable(describeConflicts(previous, project));
      const delta = descriptionDeltaOf(message.kind === 'whole' ? null : described, description);
      described = description;
      return {
        version: SCHEDULE_PROTOCOL_VERSION,
        generation: message.generation,
        result: result.ok ? success(answerOf(before, result.value)) : result,
        description: delta,
      };
    },
  };
}

/** Gives the project a request asks to schedule, throwing on changes that do not follow the project this worker holds, so that the worker fails and the page sends the whole project to a new one. */
function projectOf(request: ScheduleRequest, held: Held | null): Project {
  if (request.kind === 'whole') {
    return request.project;
  }
  if (held?.generation !== request.basis) {
    throw new Error(
      `The schedule worker received changes to the request ${String(request.basis)} it does not hold.`,
    );
  }
  return projectAfterDelta(held.project, request.changes);
}

/** Gives a description whose errors the worker can always send to the page, each one an error with the message of the error thrown. */
function sendable(description: ConflictDescription): ConflictDescription {
  return { people: sendablePart(description.people), dates: sendablePart(description.dates) };
}

/** Gives a part of a description as it is, or the error it failed with as a plain error, since a value thrown may be one the page cannot be sent. */
function sendablePart<Line>(
  part: Result<readonly Line[], unknown>,
): Result<readonly Line[], unknown> {
  if (part.ok) {
    return part;
  }
  return failure(new Error(part.error instanceof Error ? part.error.message : String(part.error)));
}

/** Gives a schedule whole when the page holds none, and otherwise only what changed since the one it holds. */
function answerOf(before: Schedule | null, schedule: Schedule): ScheduleAnswer {
  return before === null
    ? { kind: 'whole', schedule }
    : { kind: 'changes', changes: scheduleDeltaOf(before, schedule) };
}

/** Lists the buffers of the packed lists of numbers of a response, handed over to the page instead of copied, the worker keeping none of them. */
export function transferablesOf(response: ScheduleResponse): ArrayBuffer[] {
  const people = response.description.people;
  const answer = response.result.ok ? response.result.value : null;
  const changes = answer?.kind === 'changes' ? answer.changes : null;
  return packedBuffers([
    changes?.placements.numbers ?? null,
    changes?.floats.kind === 'changes' ? changes.floats.changes.numbers : null,
    changes?.tagConflicts.kind === 'times' ? changes.tagConflicts.times : null,
    people.kind === 'times' ? people.times : null,
  ]);
}
