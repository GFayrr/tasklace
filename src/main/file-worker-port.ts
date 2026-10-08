import { failure } from '../core/result';
import { runFileTask, type FileTask, type FileTaskResult } from './file-tasks';

export interface FileTaskPort {
  once(event: 'message', listener: (task: FileTask) => void): unknown;
  postMessage(result: FileTaskResult): void;
}

/** Runs the one file task a worker receives and sends back its result, a task that throws, such as on a programming error, being logged and answered with a task failure so that the main process never waits for an answer that will not come. */
export function serveFileTask(
  port: FileTaskPort,
  run: (task: FileTask) => Promise<FileTaskResult> = runFileTask,
): void {
  port.once('message', (task) => {
    run(task).then(
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
