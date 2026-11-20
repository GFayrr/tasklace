import type { Project } from '../../core/model/project';
import { success, type Result } from '../../core/result';
import type { Schedule, SchedulingFailure } from '../../core/scheduling/schedule-project';
import type { ConflictDescription } from '../plan/conflict-lines';
import {
  applyScheduleDelta,
  descriptionAfter,
  projectDeltaOf,
  scheduleOfTable,
  scheduleTableOf,
  type ScheduleTable,
} from './schedule-changes';
import {
  isScheduleResponse,
  SCHEDULE_PROTOCOL_VERSION,
  type ScheduleAnswer,
  type ScheduleRequest,
  type ScheduleResponse,
} from './schedule-protocol';

export interface SchedulePort {
  readonly postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  readonly terminate: () => void;
}

export interface Scheduler {
  readonly request: (project: Project) => void;
  readonly dispose: () => void;
}

export interface ScheduleListener {
  readonly scheduled: (
    result: Result<Schedule, SchedulingFailure>,
    project: Project,
    description: ConflictDescription,
  ) => void;
  readonly failed: (error: unknown) => void;
}

interface Shown {
  readonly result: Result<Schedule, SchedulingFailure>;
  readonly description: ConflictDescription;
}

interface InFlight {
  readonly generation: number;
  readonly project: Project;
}

export const MAX_SCHEDULE_RETRIES = 1;

/** Computes schedules in a worker started at the first request, one at a time, keeping only the latest project asked meanwhile, so that no result older than the latest change is ever shown, while a worker that fails or sends an unreadable answer is replaced and asked again for the latest project, and a failure repeated past the retry limit, or a worker that cannot be started or sent a project, is reported, the next change trying again. */
export function createScheduler(
  createPort: () => SchedulePort,
  listener: ScheduleListener,
): Scheduler {
  let generation = 0;
  let inFlight: InFlight | null = null;
  let pending: Project | null = null;
  let failures = 0;
  let port: SchedulePort | null = null;
  let held: InFlight | null = null;
  let table: ScheduleTable | null = null;
  let unshown: ScheduleResponse[] = [];
  let description: ConflictDescription | null = null;
  /** Stops the worker in use, if any, forgetting what it held since the next one starts with nothing. */
  const closePort = (): void => {
    held = null;
    table = null;
    unshown = [];
    description = null;
    if (port !== null) {
      stop(port);
      port = null;
    }
  };
  /** Writes the request for a project: the whole project to a worker holding none, else what changed since the project it holds. */
  const requestFor = (project: Project): ScheduleRequest => {
    const numbered = { version: SCHEDULE_PROTOCOL_VERSION, generation } as const;
    return held === null
      ? { ...numbered, kind: 'whole', project }
      : {
          ...numbered,
          kind: 'changes',
          basis: held.generation,
          changes: projectDeltaOf(held.project, project),
        };
  };
  /** Applies an answer to the schedule table and the description of the conflicts, giving what it shows, or throwing on changes that arrive without a schedule or a description to change. */
  const applyAnswer = ({ result, description: delta }: ScheduleResponse): Shown => {
    const described = descriptionAfter(description, delta);
    description = described;
    if (!result.ok) {
      table = null;
      return { result, description: described };
    }
    const changed = tableAfter(table, result.value);
    table = changed;
    return { result: success(scheduleOfTable(changed)), description: described };
  };
  /** Applies in order the answers held back while newer projects were asked, then the latest one, giving what the latest shows. */
  const showLatest = (latest: ScheduleResponse): Shown => {
    const earlier = unshown;
    unshown = [];
    earlier.forEach(applyAnswer);
    return applyAnswer(latest);
  };
  /** Stops computing after too many failures and tells the listener why. */
  const giveUp = (error: unknown): void => {
    inFlight = null;
    pending = null;
    failures = 0;
    closePort();
    listener.failed(error);
  };
  /** Sends a project to the worker, creating the worker first when there is none. */
  const send = (project: Project): void => {
    generation += 1;
    inFlight = { generation, project };
    try {
      port ??= connect(createPort());
      port.postMessage(requestFor(project));
      held = { generation, project };
    } catch (error) {
      giveUp(error);
    }
  };
  /** Sends the project waiting for the worker, telling whether there was one. */
  const sendPending = (): boolean => {
    if (pending === null) {
      return false;
    }
    const next = pending;
    pending = null;
    send(next);
    return true;
  };
  /** Replaces a worker that failed and sends it the latest project, giving up after too many failures in a row. */
  const fail = (error: unknown): void => {
    const latest = pending ?? inFlight?.project ?? null;
    inFlight = null;
    pending = null;
    closePort();
    if (latest === null) {
      console.error('The idle schedule worker failed and is replaced at the next request:', error);
      return;
    }
    failures += 1;
    if (failures > MAX_SCHEDULE_RETRIES) {
      failures = 0;
      listener.failed(error);
      return;
    }
    console.error('The schedule worker failed and was restarted:', error);
    send(latest);
  };
  /** Listens to the answers and errors of a new worker. */
  const connect = (created: SchedulePort): SchedulePort => {
    created.onmessage = (event) => {
      const response = event.data;
      if (!isScheduleResponse(response)) {
        fail(new Error('The schedule worker sent an unreadable answer.'));
        return;
      }
      if (response.generation !== inFlight?.generation) {
        return;
      }
      const answered = inFlight.project;
      inFlight = null;
      failures = 0;
      if (sendPending()) {
        unshown.push(response);
        return;
      }
      let shown: Shown;
      try {
        shown = showLatest(response);
      } catch (error) {
        pending = answered;
        fail(error);
        return;
      }
      listener.scheduled(shown.result, answered, shown.description);
    };
    created.onmessageerror = () => {
      fail(new Error('The answer of the schedule worker could not be received.'));
    };
    created.onerror = (event) => {
      event.preventDefault();
      fail(event.error ?? new Error(event.message));
    };
    return created;
  };
  return {
    request: (project) => {
      if (inFlight === null) {
        send(project);
        return;
      }
      pending = project;
    },
    dispose: closePort,
  };
}

/** Gives the schedule table an answer leaves: a new one for a whole schedule, the same one changed in place for changes, throwing on changes that arrive without a table. */
function tableAfter(table: ScheduleTable | null, answer: ScheduleAnswer): ScheduleTable {
  if (answer.kind === 'whole') {
    return scheduleTableOf(answer.schedule);
  }
  if (table === null) {
    throw new Error('The schedule worker sent changes to a schedule the page does not hold.');
  }
  applyScheduleDelta(table, answer.changes);
  return table;
}

/** Stops a worker and stops listening to it. */
function stop(port: SchedulePort): void {
  port.onmessage = null;
  port.onerror = null;
  port.onmessageerror = null;
  port.terminate();
}
