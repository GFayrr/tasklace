import { createScheduleHost, transferablesOf } from './schedule-host';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
}

const scope = self as unknown as WorkerScope;
const host = createScheduleHost();

scope.onmessage = (event) => {
  const response = host.answer(event.data);
  scope.postMessage(response, transferablesOf(response));
};
