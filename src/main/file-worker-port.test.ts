import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '../core/result';
import type { FileTask, FileTaskResult } from './file-tasks';
import { serveFileTask, type FileTaskPort } from './file-worker-port';

const TASK: FileTask = { kind: 'openProject', path: '/nowhere/Plan.tasklace' };

/** Creates a port that delivers one task and records the results sent back. */
function fakePort(): FileTaskPort & {
  readonly deliver: (task: FileTask) => void;
  readonly sent: FileTaskResult[];
} {
  let listener: ((task: FileTask) => void) | null = null;
  const sent: FileTaskResult[] = [];
  return {
    once: (_event, next) => {
      listener = next;
    },
    postMessage: (result) => {
      sent.push(result);
    },
    deliver: (task) => {
      listener?.(task);
    },
    sent,
  };
}

/** Waits until pending promise callbacks have run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('serveFileTask', () => {
  it('sends back the result of the task it receives', async () => {
    const port = fakePort();
    const result = success({ kind: 'saved' as const, localCopySaved: true });
    const run = vi.fn(() => Promise.resolve(result));
    serveFileTask(port, run);
    port.deliver(TASK);
    await settle();
    expect(run).toHaveBeenCalledWith(TASK);
    expect(port.sent).toEqual([result]);
  });

  it('answers a task that throws, such as on a programming error, with a task failure, logging the error', async () => {
    const port = fakePort();
    const fault = new TypeError('A programming error on purpose');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      serveFileTask(port, () => Promise.reject(fault));
      port.deliver(TASK);
      await settle();
      expect(port.sent).toEqual([failure({ code: 'TASK_FAILED' })]);
      expect(logged.mock.calls).toEqual([['The file task openProject failed:', fault]]);
    } finally {
      logged.mockRestore();
    }
  });

  it('runs the real file tasks by default, a missing file giving a read failure', async () => {
    const port = fakePort();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      serveFileTask(port);
      port.deliver(TASK);
      await vi.waitFor(() => {
        expect(port.sent).toEqual([failure({ code: 'READ_FAILED' })]);
      });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
