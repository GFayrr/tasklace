import type { Project } from '../../core/model/project';
import { success } from '../../core/result';
import { scheduleProject, type Schedule } from '../../core/scheduling/schedule-project';
import { describeConflicts, type ConflictDescription } from '../plan/conflict-lines';
import { descriptionDeltaOf, projectAfterDelta, scheduleDeltaOf } from './schedule-changes';
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
      const description = describeConflicts(previous, project);
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

/** Gives a schedule whole when the page holds none, and otherwise only what changed since the one it holds. */
function answerOf(before: Schedule | null, schedule: Schedule): ScheduleAnswer {
  return before === null
    ? { kind: 'whole', schedule }
    : { kind: 'changes', changes: scheduleDeltaOf(before, schedule) };
}
