import type { Worker } from 'node:worker_threads';
import { failure } from '../core/result';
import type { FileTask, FileTaskResult } from './file-tasks';

export type FileWorkerFactory = () => Worker;

const OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY';

/** Runs one file task in its own worker, stopped afterwards, turning a worker that runs out of memory into a "too complex" failure and any other stop into a task failure, whose cause is logged. */
export function runInFileWorker(
  createWorker: FileWorkerFactory,
  task: FileTask,
): Promise<FileTaskResult> {
  return new Promise((resolve) => {
    const worker = createWorker();
    let settled = false;
    const finish = (result: FileTaskResult, cause: unknown = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (cause !== null) {
        console.error(`The file task ${task.kind} failed:`, cause);
      }
      resolve(result);
      void worker.terminate();
    };
    worker.once('message', (result: unknown) => {
      if (isFileTaskResult(result)) {
        finish(result);
        return;
      }
      finish(failure({ code: 'TASK_FAILED' }), 'the worker sent an unreadable answer');
    });
    worker.once('error', (error) => {
      finish(failure({ code: isOutOfMemory(error) ? 'TOO_COMPLEX' : 'TASK_FAILED' }), error);
    });
    worker.once('exit', (exitCode) => {
      finish(failure({ code: 'TASK_FAILED' }), `the worker stopped with code ${String(exitCode)}`);
    });
    worker.postMessage(task);
  });
}

/** Tells whether a worker stopped because it reached its memory limit. */
function isOutOfMemory(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === OUT_OF_MEMORY_CODE;
}

/** Tells whether a message from the worker has the shape of a task result. */
function isFileTaskResult(value: unknown): value is FileTaskResult {
  return typeof Reflect.get(Object(value), 'ok') === 'boolean';
}
