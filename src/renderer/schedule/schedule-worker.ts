import { createScheduleHost } from './schedule-host';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown) => void;
}

const scope = self as unknown as WorkerScope;
const host = createScheduleHost();

scope.onmessage = (event) => {
  scope.postMessage(host.answer(event.data));
};
