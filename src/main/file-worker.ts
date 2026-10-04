import { parentPort } from 'node:worker_threads';
import { failure } from '../core/result';
import { runFileTask, type FileTask } from './file-tasks';

const port = parentPort;

if (port !== null) {
  port.once('message', (task: FileTask) => {
    runFileTask(task).then(
      (result) => {
        port.postMessage(result);
      },
      (error: unknown) => {
        console.error(`The file task ${task.kind} failed:`, error);
        port.postMessage(failure({ code: 'TASK_FAILED' }));
      },
    );
  });
}
