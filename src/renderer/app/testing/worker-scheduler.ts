import { createScheduleHost, transferablesOf } from '../../schedule/schedule-host';
import {
  createScheduler,
  type ScheduleListener,
  type Scheduler,
  type SchedulePort,
} from '../../schedule/scheduler';

/** Builds a port that answers each request a moment later through the real schedule host, copying each message both ways and handing over its packed lists as a worker does. */
function hostPort(): SchedulePort {
  const host = createScheduleHost();
  const port: SchedulePort = {
    postMessage: (message) => {
      const request = structuredClone(message);
      queueMicrotask(() => {
        const answer = host.answer(request);
        const data = structuredClone(answer, { transfer: transferablesOf(answer) });
        port.onmessage?.(new MessageEvent('message', { data }));
      });
    },
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate: () => undefined,
  };
  return port;
}

/** Creates the real scheduler of the page over the real schedule host, so that the page keeps tables changed in place as it does with a worker. */
export function workerScheduler(listener: ScheduleListener): Scheduler {
  return createScheduler(hostPort, listener);
}
