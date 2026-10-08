import type { Worker } from 'node:worker_threads';
import { failure } from '../core/result';
import { isResultOf, type FileTask, type ResultOfTask } from './file-tasks';

export type FileWorkerFactory = () => Worker;

const OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY';

/** Runs one file task in its own worker, stopped afterwards, a worker out of memory giving a “too complex” failure and any other stop, unsent task or answer foreign to the task a task failure whose cause is logged. */
export function runInFileWorker<T extends FileTask>(
  createWorker: FileWorkerFactory,
  task: T,
): Promise<ResultOfTask<T>> {
  return new Promise((resolve) => {
    const worker = createWorker();
    let settled = false;
    /** Answers the task once, logging the cause of a failure, then stops the worker. */
    const finish = (result: ResultOfTask<T>, cause: unknown = null): void => {
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
      if (isResultOf(task, result)) {
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
    try {
      worker.postMessage(task);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      finish(failure({ code: 'TASK_FAILED' }), error);
    }
  });
}

/** Tells whether a worker stopped because it reached its memory limit. */
function isOutOfMemory(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === OUT_OF_MEMORY_CODE;
}
