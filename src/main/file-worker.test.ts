import { describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => {
  const posted: unknown[] = [];
  let receive: (task: unknown) => void = () => undefined;
  return {
    posted,
    port: {
      once: (_event: string, listener: (task: unknown) => void) => {
        receive = listener;
      },
      postMessage: (value: unknown) => {
        posted.push(value);
      },
    },
    send: (task: unknown) => {
      receive(task);
    },
  };
});

const failing = vi.hoisted(() => new Error('task broken'));

vi.mock('node:worker_threads', () => ({ parentPort: worker.port }));

vi.mock('./file-tasks', () => ({
  runFileTask: () => Promise.reject(failing),
}));

describe('the file worker', () => {
  it('answers a task that fails with a task failure, logging why, instead of stopping', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('./file-worker');
      worker.send({ kind: 'openProject', path: '/plan.tasklace' });
      await vi.waitFor(() => {
        expect(worker.posted).toEqual([{ ok: false, error: { code: 'TASK_FAILED' } }]);
      });
      expect(logged.mock.calls).toEqual([['The file task openProject failed:', failing]]);
    } finally {
      logged.mockRestore();
    }
  });
});
