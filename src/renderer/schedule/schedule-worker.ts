import { answerScheduleRequest } from './schedule-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown) => void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const response = answerScheduleRequest(event.data);
  if (response !== null) {
    scope.postMessage(response);
  }
};
