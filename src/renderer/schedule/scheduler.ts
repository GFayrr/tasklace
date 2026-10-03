import type { Project } from '../../core/model/project';
import type { Result } from '../../core/result';
import type { Schedule, SchedulingFailure } from '../../core/scheduling/schedule-project';
import { isScheduleResponse, SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';

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
  readonly scheduled: (result: Result<Schedule, SchedulingFailure>, project: Project) => void;
  readonly failed: (error: unknown) => void;
}

interface InFlight {
  readonly generation: number;
  readonly project: Project;
}

export const MAX_SCHEDULE_RETRIES = 1;

/** Computes schedules in a worker, one at a time, keeping only the latest project asked meanwhile, so that no result older than the latest change is ever shown; when the worker fails or sends an unreadable answer, it is replaced by a new one that is asked again for the latest project, and only a failure repeated past the retry limit is reported, the next change trying again. */
export function createScheduler(
  createPort: () => SchedulePort,
  listener: ScheduleListener,
): Scheduler {
  let generation = 0;
  let inFlight: InFlight | null = null;
  let pending: Project | null = null;
  let failures = 0;
  let port = createPort();
  const send = (project: Project): void => {
    generation += 1;
    inFlight = { generation, project };
    port.postMessage({ version: SCHEDULE_PROTOCOL_VERSION, generation, project });
  };
  const sendPending = (): boolean => {
    if (pending === null) {
      return false;
    }
    const next = pending;
    pending = null;
    send(next);
    return true;
  };
  const fail = (error: unknown): void => {
    const latest = pending ?? inFlight?.project ?? null;
    inFlight = null;
    pending = null;
    stop(port);
    port = connect(createPort());
    if (latest === null) {
      console.error('The idle schedule worker failed and was restarted:', error);
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
      if (!sendPending()) {
        listener.scheduled(response.result, answered);
      }
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
  port = connect(port);
  return {
    request: (project) => {
      if (inFlight === null) {
        send(project);
        return;
      }
      pending = project;
    },
    dispose: () => {
      stop(port);
    },
  };
}

/** Stops a worker and stops listening to it. */
function stop(port: SchedulePort): void {
  port.onmessage = null;
  port.onerror = null;
  port.onmessageerror = null;
  port.terminate();
}
