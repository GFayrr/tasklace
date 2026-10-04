import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { runInFileWorker } from './file-worker-client';

const TASK = { kind: 'openProject', path: '/nowhere' } as const;
const SMALL_HEAP_MEBIBYTES = 16;

/** Returns a factory of workers running some JavaScript with a small memory limit. */
function workerRunning(code: string): () => Worker {
  return () =>
    new Worker(code, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: SMALL_HEAP_MEBIBYTES },
    });
}

describe('runInFileWorker', () => {
  it('gives back the result the worker sends', async () => {
    const result = await runInFileWorker(
      workerRunning(
        "const { parentPort } = require('node:worker_threads'); parentPort.once('message', () => parentPort.postMessage({ ok: true, value: { kind: 'loaded' } }));",
      ),
      TASK,
    );
    expect(result).toEqual({ ok: true, value: { kind: 'loaded' } });
  });

  it('reports a worker that runs out of memory as too complex, the caller surviving', async () => {
    const result = await runInFileWorker(
      workerRunning('const kept = []; for (;;) kept.push(new Array(1e5).fill({}));'),
      TASK,
    );
    expect(result).toEqual({ ok: false, error: { code: 'TOO_COMPLEX' } });
  });

  it.each([
    ['throws', "throw new Error('broken');"],
    ['stops without answering', 'process.exit(0);'],
    [
      'answers something else',
      "require('node:worker_threads').parentPort.postMessage('nonsense');",
    ],
    [
      'answers an opening with a saved file',
      "require('node:worker_threads').parentPort.postMessage({ ok: true, value: { kind: 'saved' } });",
    ],
    [
      'answers with a success without value',
      "require('node:worker_threads').parentPort.postMessage({ ok: true });",
    ],
  ])('reports a worker that %s as a task failure', async (_label, code) => {
    expect(await runInFileWorker(workerRunning(code), TASK)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
  });
});
