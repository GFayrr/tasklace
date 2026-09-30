import type { Project } from '../../core/model/project';
import type { Result } from '../../core/result';
import type { Schedule, SchedulingFailure } from '../../core/scheduling/schedule-project';
import { isScheduleResponse, SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';

export interface SchedulePort {
  readonly postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
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

/** Computes schedules in a worker, one at a time, keeping only the latest project asked meanwhile, so that no result older than the latest change is ever shown. */
export function createScheduler(port: SchedulePort, listener: ScheduleListener): Scheduler {
  let generation = 0;
  let inFlight: InFlight | null = null;
  let pending: Project | null = null;
  const send = (project: Project): void => {
    generation += 1;
    inFlight = { generation, project };
    port.postMessage({ version: SCHEDULE_PROTOCOL_VERSION, generation, project });
  };
  port.onmessage = (event) => {
    const response = event.data;
    if (!isScheduleResponse(response) || response.generation !== inFlight?.generation) {
      return;
    }
    const answered = inFlight.project;
    inFlight = null;
    if (pending !== null) {
      const next = pending;
      pending = null;
      send(next);
      return;
    }
    listener.scheduled(response.result, answered);
  };
  port.onerror = (event) => {
    inFlight = null;
    pending = null;
    listener.failed(event.error ?? event.message);
  };
  return {
    request: (project) => {
      if (inFlight === null) {
        send(project);
        return;
      }
      pending = project;
    },
    dispose: () => {
      port.onmessage = null;
      port.onerror = null;
      port.terminate();
    },
  };
}
