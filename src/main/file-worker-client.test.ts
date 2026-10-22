import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE_WORKER_HEAP_MEBIBYTES } from '../core/limits';
import { runInFileWorker, startFileWorker } from './file-worker-client';

const TASK = { kind: 'openProject', path: '/nowhere', localCopyFolder: '/nowhere/copies' } as const;
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

  it('reports a task that cannot be sent as failed, logging why and stopping its worker', async () => {
    let started: Worker | null = null;
    const factory = workerRunning(
      "require('node:worker_threads').parentPort.once('message', () => {});",
    );
    const unsendable = {
      kind: 'openProject',
      path: '/nowhere',
      localCopyFolder: '/nowhere/copies',
      extra: () => undefined,
    } as const;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runInFileWorker(() => {
        started = factory();
        return started;
      }, unsendable);
      expect(result).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      expect(
        logged.mock.calls.map((call: unknown[]) => [String(call[0]), (call[1] as Error).name]),
      ).toEqual([['The file task openProject failed:', 'DataCloneError']]);
    } finally {
      logged.mockRestore();
    }
    const worker = started as Worker | null;
    await vi.waitFor(() => {
      expect(worker?.threadId).toBe(-1);
    });
  });

  it('reports an answer that could not be received as failed, logging why rather than the stop of the worker that follows', async () => {
    const unreadable = new RangeError('Array buffer allocation failed');
    const worker = Object.assign(new EventEmitter(), {
      postMessage: () => {
        worker.emit('messageerror', unreadable);
        worker.emit('exit', 0);
      },
      terminate: () => Promise.resolve(0),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runInFileWorker(() => worker as unknown as Worker, TASK);
    const calls = [...logged.mock.calls];
    logged.mockRestore();
    expect(result).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
    expect(calls).toEqual([['The file task openProject failed:', unreadable]]);
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

describe('startFileWorker', () => {
  it('starts the worker of a script with the memory limit of file tasks, handing its error output to be logged', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tasklace-worker-'));
    const script = join(folder, 'worker.cjs');
    await writeFile(script, "process.stderr.write('started');");
    try {
      const outputs: Readable[] = [];
      const worker = startFileWorker(script, (stderr) => {
        outputs.push(stderr);
      });
      expect(worker.resourceLimits?.maxOldGenerationSizeMb).toBe(MAX_FILE_WORKER_HEAP_MEBIBYTES);
      expect(outputs).toEqual([worker.stderr]);
      const written: string[] = [];
      worker.stderr.on('data', (chunk: Buffer) => written.push(chunk.toString()));
      await new Promise((resolve) => worker.once('exit', resolve));
      expect(written.join('')).toBe('started');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
