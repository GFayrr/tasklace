import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { project, workTask } from '../../core/testing/project-builder';
import { answerScheduleRequest, SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';
import { createScheduler, MAX_SCHEDULE_RETRIES, type SchedulePort } from './scheduler';

/** A worker that answers only when told to, through the real request handler. */
function manualWorker() {
  const received: unknown[] = [];
  let terminated = false;
  const port: SchedulePort = {
    postMessage: (message) => received.push(message),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate: () => {
      terminated = true;
    },
  };
  const answerNext = () => {
    const response = answerScheduleRequest(received.shift());
    port.onmessage?.(new MessageEvent('message', { data: response }));
  };
  return { port, received, answerNext, isTerminated: () => terminated };
}

/** Creates workers on demand, as the scheduler asks for them, keeping each one for the test. */
function workerPool() {
  const created: ReturnType<typeof manualWorker>[] = [];
  const latest = () => {
    const worker = created.at(-1);
    if (worker === undefined) {
      throw new Error('No worker was created');
    }
    return worker;
  };
  const create = () => {
    const worker = manualWorker();
    created.push(worker);
    return worker.port;
  };
  return { created, latest, create };
}

/** Runs a test step while silencing, and returning, what it logs as errors. */
function quietly(step: () => void): unknown[][] {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    step();
    return logged.mock.calls;
  } finally {
    logged.mockRestore();
  }
}

/** Builds the error event a failing worker sends, which this test environment has no constructor for. */
function workerError(message: string, error: unknown): ErrorEvent {
  return Object.assign(new Event('error', { cancelable: true }), { message, error }) as ErrorEvent;
}

/** Returns a listener recording the projects it is given a schedule for. */
function recorder() {
  const scheduled: Project[] = [];
  const failures: unknown[] = [];
  return {
    scheduled,
    failures,
    listener: {
      scheduled: (_result: unknown, answered: Project) => scheduled.push(answered),
      failed: (error: unknown) => failures.push(error),
    },
  };
}

const FIRST = project([workTask('a')]);
const SECOND = project([workTask('a'), workTask('b')]);
const THIRD = project([workTask('c')]);

describe('createScheduler', () => {
  it('schedules a project in the worker and gives the result with the project it belongs to', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST]);
    expect(pool.created).toHaveLength(1);
  });

  it('keeps only the latest project asked while computing, and never shows an older result', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    scheduler.request(SECOND);
    scheduler.request(THIRD);
    const worker = pool.latest();
    expect(worker.received).toHaveLength(1);
    worker.answerNext();
    expect(record.scheduled).toEqual([]);
    expect(worker.received).toHaveLength(1);
    worker.answerNext();
    expect(record.scheduled).toEqual([THIRD]);
  });

  it('ignores an answer to an older request', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    const stale = {
      version: SCHEDULE_PROTOCOL_VERSION,
      generation: 99,
      result: { ok: false, error: { code: 'EMPTY_CALENDAR' } },
    };
    const worker = pool.latest();
    worker.port.onmessage?.(new MessageEvent('message', { data: stale }));
    expect(record.scheduled).toEqual([]);
    expect(record.failures).toEqual([]);
    worker.answerNext();
    expect(record.scheduled).toEqual([FIRST]);
  });

  it.each([
    ['noise'],
    [null],
    [{ version: SCHEDULE_PROTOCOL_VERSION, generation: 1, result: null }],
    [{ version: SCHEDULE_PROTOCOL_VERSION, generation: 1, result: { ok: 'yes' } }],
    [{ version: SCHEDULE_PROTOCOL_VERSION + 1, generation: 1, result: { ok: true } }],
    [{ version: SCHEDULE_PROTOCOL_VERSION, generation: 1, result: { ok: true, value: {} } }],
    [
      {
        version: SCHEDULE_PROTOCOL_VERSION,
        generation: 1,
        result: {
          ok: true,
          value: { placements: new Map(), summaries: new Map(), wbsNumbers: {} },
        },
      },
    ],
  ])(
    'replaces a worker that sends the unreadable answer %j, asking the new one for the latest project',
    (data) => {
      const pool = workerPool();
      const record = recorder();
      const scheduler = createScheduler(pool.create, record.listener);
      scheduler.request(FIRST);
      scheduler.request(SECOND);
      const first = pool.latest();
      const logged = quietly(() => {
        first.port.onmessage?.(new MessageEvent('message', { data }));
      });
      expect(logged).toHaveLength(1);
      expect(record.failures).toEqual([]);
      expect(first.isTerminated()).toBe(true);
      expect(first.port.onmessage).toBeNull();
      const second = pool.latest();
      expect(second).not.toBe(first);
      second.answerNext();
      expect(record.scheduled).toEqual([SECOND]);
    },
  );

  it('asks the new worker again for the project in flight when nothing newer was asked', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    quietly(() => {
      pool.latest().port.onmessageerror?.(new MessageEvent('messageerror'));
    });
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST]);
    expect(pool.created).toHaveLength(2);
  });

  it('reports a failure repeated past the retry limit, then tries again with the next change', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    const crash = workerError('crashed', undefined);
    quietly(() => {
      for (let attempt = 0; attempt <= MAX_SCHEDULE_RETRIES; attempt += 1) {
        pool.latest().port.onerror?.(crash);
      }
    });
    expect(record.failures).toEqual([new Error('crashed')]);
    expect(crash.defaultPrevented).toBe(true);
    expect(pool.created).toHaveLength(MAX_SCHEDULE_RETRIES + 1);
    expect(pool.created.every((worker) => worker.isTerminated())).toBe(true);
    scheduler.request(SECOND);
    expect(pool.created).toHaveLength(MAX_SCHEDULE_RETRIES + 2);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([SECOND]);
  });

  it('counts only failures in a row, a schedule computed in between starting the count again', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    quietly(() => {
      scheduler.request(FIRST);
      pool.latest().port.onmessageerror?.(new MessageEvent('messageerror'));
      pool.latest().answerNext();
      scheduler.request(SECOND);
      pool.latest().port.onmessageerror?.(new MessageEvent('messageerror'));
      pool.latest().answerNext();
    });
    expect(record.failures).toEqual([]);
    expect(record.scheduled).toEqual([FIRST, SECOND]);
  });

  it('passes on the error a worker failure carries', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    const cause = new RangeError('out of memory');
    quietly(() => {
      pool.latest().port.onerror?.(workerError('x', cause));
      pool.latest().port.onerror?.(workerError('x', cause));
    });
    expect(record.failures).toEqual([cause]);
  });

  it('replaces an idle worker that fails without telling the user, at the next request', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    pool.latest().answerNext();
    const logged = quietly(() => {
      pool.latest().port.onerror?.(workerError('idle', undefined));
    });
    expect(logged).toEqual([
      ['The idle schedule worker failed and is replaced at the next request:', new Error('idle')],
    ]);
    expect(record.failures).toEqual([]);
    expect(pool.created).toHaveLength(1);
    scheduler.request(SECOND);
    expect(pool.created).toHaveLength(2);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST, SECOND]);
  });

  it('starts no worker before the first request, reports one that cannot be started, and tries again with the next change', () => {
    const pool = workerPool();
    const record = recorder();
    let refuse = true;
    const scheduler = createScheduler(() => {
      if (refuse) {
        throw new Error('no worker');
      }
      return pool.create();
    }, record.listener);
    expect(record.failures).toEqual([]);
    scheduler.request(FIRST);
    expect(record.failures).toEqual([new Error('no worker')]);
    refuse = false;
    scheduler.request(SECOND);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([SECOND]);
  });

  it('reports a project that cannot be sent to the worker, and sends the next change', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(() => {
      const port = pool.create();
      if (pool.created.length === 1) {
        Object.assign(port, {
          postMessage: () => {
            throw new DOMException('Cannot clone', 'DataCloneError');
          },
        });
      }
      return port;
    }, record.listener);
    scheduler.request(FIRST);
    expect(record.failures).toEqual([new DOMException('Cannot clone', 'DataCloneError')]);
    expect(pool.latest().isTerminated()).toBe(true);
    scheduler.request(SECOND);
    expect(pool.created).toHaveLength(2);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([SECOND]);
  });

  it('stops the worker when disposed, and starts none when disposed before any request', () => {
    const pool = workerPool();
    createScheduler(pool.create, recorder().listener).dispose();
    expect(pool.created).toEqual([]);
    const scheduler = createScheduler(pool.create, recorder().listener);
    scheduler.request(FIRST);
    scheduler.dispose();
    const worker = pool.latest();
    expect(worker.isTerminated()).toBe(true);
    expect(worker.port.onmessage).toBeNull();
    expect(worker.port.onerror).toBeNull();
    expect(worker.port.onmessageerror).toBeNull();
  });
});

describe('answerScheduleRequest', () => {
  it('answers only requests of the current version', () => {
    expect(answerScheduleRequest({ version: 2, generation: 1, project: FIRST })).toBeNull();
    expect(answerScheduleRequest({ version: 1, generation: 1.5, project: FIRST })).toBeNull();
    expect(answerScheduleRequest(null)).toBeNull();
    const answer = answerScheduleRequest({ version: 1, generation: 3, project: FIRST });
    expect(answer?.generation).toBe(3);
    expect(answer?.result.ok).toBe(true);
  });
});
