import { parentPort } from 'node:worker_threads';
import { runFileTask, type FileTask } from './file-tasks';

const port = parentPort;

if (port !== null) {
  port.once('message', (task: FileTask) => {
    void runFileTask(task).then((result) => {
      port.postMessage(result);
    });
  });
}
