import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { compareStrings } from '../../core/compare-strings';
import type { Result } from '../../core/result';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { richProjectArbitrary } from '../../core/testing/project-arbitrary';
import { describeConflicts, type ConflictDescription } from '../plan/conflict-lines';
import type { Project } from '../../core/model/project';
import { project, workTask } from '../../core/testing/project-builder';
import { HOURS_PER_DAY, isProjectHour } from '../../core/time';
import { createScheduleHost, transferablesOf } from './schedule-host';
import { SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';
import { createScheduler, MAX_SCHEDULE_RETRIES, type SchedulePort } from './scheduler';

/** Builds the error event a failing worker sends, which this test environment has no constructor for. */
function workerError(message: string, error: unknown): ErrorEvent {
  return Object.assign(new Event('error', { cancelable: true }), { message, error }) as ErrorEvent;
}

/** A worker that answers only when told to, through the real host, copying each message both ways and handing over its packed lists as the browser does. */
function manualWorker() {
  const received: unknown[] = [];
  const host = createScheduleHost();
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
  /** Answers the oldest request the worker received. */
  const answerNext = () => {
    let response: unknown;
    try {
      const answer = host.answer(structuredClone(received.shift()));
      response = structuredClone(answer, { transfer: transferablesOf(answer) });
    } catch (error) {
      port.onerror?.(workerError(String(error), error));
      return;
    }
    port.onmessage?.(new MessageEvent('message', { data: response }));
  };
  return { port, received, answerNext, isTerminated: () => terminated };
}

/** Creates workers on demand, as the scheduler asks for them, keeping each one for the test. */
function workerPool() {
  const created: ReturnType<typeof manualWorker>[] = [];
  /** Returns the worker created last, failing the test when none was created. */
  const latest = () => {
    const worker = created.at(-1);
    if (worker === undefined) {
      throw new Error('No worker was created');
    }
    return worker;
  };
  /** Creates a worker the test drives by hand. */
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

/** Returns a listener recording the projects it is given a schedule for. */
function recorder() {
  const scheduled: Project[] = [];
  const failures: unknown[] = [];
  const drops: Project[][] = [];
  return {
    scheduled,
    failures,
    drops,
    listener: {
      scheduled: (_result: unknown, answered: Project) => scheduled.push(answered),
      failed: (error: unknown) => failures.push(error),
      dropped: () => drops.push([...scheduled]),
    },
  };
}

const FIRST = project([workTask('a')]);
const SECOND = project([workTask('a'), workTask('b')]);
const THIRD = project([workTask('c')]);

const NO_LINES = { kind: 'whole', lines: { ok: true, value: [] } };
const DESCRIBED = { people: NO_LINES, dates: NO_LINES };
const EMPTY_MAP_DELTA = { put: [], removed: [] };
const EMPTY_PACKED = { ids: [], numbers: new Float64Array(0), removed: [] };

/** Writes a response of the current version to the first request, with a result and conflicts described without any line. */
function responseWith(result: unknown, generation = 1) {
  return { version: SCHEDULE_PROTOCOL_VERSION, generation, result, description: DESCRIBED };
}

/** Writes a response giving a whole schedule, with some fields of an empty schedule replaced. */
function whole(fields: object) {
  const schedule = {
    placements: new Map(),
    summaries: new Map(),
    wbsNumbers: new Map(),
    floats: null,
    conflicts: [],
    tagConflicts: { conflicts: [], tasksWithUnknownTag: [] },
    ...fields,
  };
  return responseWith({ ok: true, value: { kind: 'whole', schedule } });
}

/** Writes a response giving the changes of a schedule, with some fields of changes that change nothing replaced. */
function changes(fields: object, generation = 1) {
  const delta = {
    placements: EMPTY_PACKED,
    summaries: EMPTY_MAP_DELTA,
    wbsNumbers: EMPTY_MAP_DELTA,
    floats: { kind: 'same' },
    conflicts: null,
    tagConflicts: { kind: 'same' },
    ...fields,
  };
  return responseWith({ ok: true, value: { kind: 'changes', changes: delta } }, generation);
}

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

  it('replaces a worker that answers a request it was not sent, asking the new one for the latest project', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    const stale = responseWith({ ok: false, error: { kind: 'startDate' } }, 99);
    const worker = pool.latest();
    const logged = quietly(() => {
      worker.port.onmessage?.(new MessageEvent('message', { data: stale }));
    });
    expect(logged).toEqual([
      [
        'The schedule worker failed and was restarted:',
        new Error('The schedule worker answered a request it was not waiting on.'),
      ],
    ]);
    expect(worker.isTerminated()).toBe(true);
    expect(record.scheduled).toEqual([]);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST]);
  });

  it('forgets an answer held back for a project it then could not send, so that the next worker starts clean', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    const first = pool.latest();
    first.answerNext();
    scheduler.request(SECOND);
    scheduler.request(THIRD);
    Object.assign(first.port, {
      postMessage: () => {
        throw new DOMException('Cannot clone', 'DataCloneError');
      },
    });
    const logged = quietly(() => {
      first.answerNext();
    });
    expect(record.failures).toEqual([new DOMException('Cannot clone', 'DataCloneError')]);
    const later = quietly(() => {
      scheduler.request(FIRST);
      pool.latest().answerNext();
    });
    expect([logged, later, record.scheduled]).toEqual([[], [], [FIRST, FIRST]]);
  });

  it.each([
    ['noise'],
    [null],
    [responseWith(null)],
    [responseWith({ ok: 'yes' })],
    [{ ...responseWith({ ok: true }), version: SCHEDULE_PROTOCOL_VERSION + 1 }],
    [responseWith({ ok: true, value: {} })],
    [responseWith({ ok: true, value: { kind: 'whole', schedule: {} } })],
    [whole({ wbsNumbers: {} })],
    [whole({ floats: {} })],
    [whole({ tagConflicts: { conflicts: [] } })],
    [responseWith({ ok: false, error: { code: 'EMPTY_CALENDAR' } })],
    [changes({ placements: { put: [] } })],
    [changes({ placements: { ...EMPTY_PACKED, numbers: [] } })],
    [changes({ placements: { ...EMPTY_PACKED, ids: null } })],
    [changes({ placements: { ...EMPTY_PACKED, removed: null } })],
    [changes({ summaries: EMPTY_PACKED })],
    [changes({ floats: { kind: 'changes', changes: EMPTY_MAP_DELTA } })],
    [changes({ tagConflicts: null })],
    [changes({ tagConflicts: { kind: 'whole', report: { conflicts: [] } } })],
    [changes({ tagConflicts: { kind: 'times', times: [] } })],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, people: { kind: 'times', times: [] } },
      },
    ],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, dates: { kind: 'times', times: new Float64Array(0) } },
      },
    ],
    [changes({ floats: { kind: 'whole', floats: {} } })],
    [changes({ floats: { kind: 'changes', changes: {} } })],
    [changes({ floats: { kind: 'other' } })],
    [changes({ conflicts: {} })],
    [changes({ tagConflicts: { conflicts: [] } })],
    [{ ...responseWith({ ok: false, error: { kind: 'startDate' } }), description: null }],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, people: { kind: 'changes', length: 1.5, put: [] } },
      },
    ],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, dates: { kind: 'changes', length: 0, put: {} } },
      },
    ],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, dates: { kind: 'other' } },
      },
    ],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, people: { kind: 'whole', lines: { ok: true, value: {} } } },
      },
    ],
    [
      {
        ...responseWith({ ok: false, error: { kind: 'startDate' } }),
        description: { ...DESCRIBED, dates: { kind: 'whole', lines: { ok: false } } },
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
      expect(logged).toEqual([
        [
          'The schedule worker failed and was restarted:',
          new Error('The schedule worker sent an unreadable answer.'),
        ],
      ]);
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

/** Returns a project whose lists are sorted by identifier, as a session gives them. */
function sorted(input: Project): Project {
  /** Sorts items by identifier. */
  const byId = <Item extends { readonly id: string }>(items: readonly Item[]) =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...input,
    tasks: byId(input.tasks),
    dependencies: byId(input.dependencies),
    tags: byId(input.tags),
  };
}

/** Changes a project as one step of a test may: another project, a renamed first task, the critical path turned on or off, or the project start moved a day later or earlier within the years handled. */
function changed(
  previous: Project,
  step: { readonly kind: string; readonly other: Project },
): Project {
  const [first, ...rest] = previous.tasks;
  if (step.kind === 'rename' && first !== undefined) {
    return { ...previous, tasks: [{ ...first, name: `${first.name}!` }, ...rest] };
  }
  if (step.kind === 'option') {
    const options = previous.options;
    return {
      ...previous,
      options: { ...options, criticalPathEnabled: !options.criticalPathEnabled },
    };
  }
  if (step.kind === 'later' || step.kind === 'earlier') {
    const shift = step.kind === 'later' ? HOURS_PER_DAY : -HOURS_PER_DAY;
    const startDate = previous.startDate + shift;
    return isProjectHour(startDate) ? { ...previous, startDate } : previous;
  }
  return step.kind === 'other' ? sorted(step.other) : previous;
}

/** Checks that a schedule shown, at the moment it is shown, and its conflicts are those a full computation gives for its project. */
function expectComputed(
  result: Result<Schedule, SchedulingFailure>,
  answered: Project,
  description: ConflictDescription,
): void {
  const expected = scheduleProject(answered);
  expect(result).toEqual(expected);
  expect(description).toEqual(describeConflicts(expected.ok ? expected.value : null, answered));
}

describe('createScheduler with the real host', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('gives for each shown project the schedule and conflicts a full computation gives, whatever the answers held back and the workers lost', () => {
    const step = fc.record({
      kind: fc.constantFrom('rename', 'option', 'later', 'earlier', 'other'),
      other: richProjectArbitrary.map((generated) => generated.project),
      then: fc.constantFrom('answer', 'wait', 'lose'),
    });
    fc.assert(
      fc.property(richProjectArbitrary, fc.array(step, { maxLength: 8 }), (start, steps) => {
        const pool = workerPool();
        const seen: { last: Project | null; stopped: boolean } = { last: null, stopped: false };
        const scheduler = createScheduler(pool.create, {
          scheduled: (result, answered, description) => {
            expectComputed(result, answered, description);
            seen.last = answered;
            seen.stopped = false;
          },
          failed: () => {
            seen.stopped = true;
          },
          dropped: () => {
            seen.last = null;
          },
        });
        /** Answers everything the latest worker received. */
        const answerAll = () => {
          while (pool.created.length > 0 && pool.latest().received.length > 0) {
            pool.latest().answerNext();
          }
        };
        let current = sorted(start.project);
        quietly(() => {
          scheduler.request(current);
          for (const { kind, other, then } of steps) {
            current = changed(current, { kind, other });
            scheduler.request(current);
            if (then === 'answer') {
              answerAll();
            } else if (then === 'lose') {
              pool.latest().port.onmessageerror?.(new MessageEvent('messageerror'));
            }
          }
          answerAll();
        });
        if (seen.stopped) {
          quietly(() => {
            scheduler.request(current);
            answerAll();
          });
        }
        expect(seen.stopped).toBe(false);
        expect(seen.last).toBe(current);
      }),
      { numRuns: 40 },
    );
  });

  it('asks a new worker for the whole project when changes arrive for a schedule the page does not hold', () => {
    const pool = workerPool();
    const record = recorder();
    createScheduler(pool.create, record.listener).request(FIRST);
    const first = pool.latest();
    first.received.shift();
    const logged = quietly(() => {
      first.port.onmessage?.(new MessageEvent('message', { data: changes({}) }));
    });
    expect(logged).toEqual([
      [
        'The schedule worker failed and was restarted:',
        new Error('The schedule worker sent changes to a schedule the page does not hold.'),
      ],
    ]);
    const second = pool.latest();
    expect(second).not.toBe(first);
    expect(second.received).toEqual([
      { version: SCHEDULE_PROTOCOL_VERSION, generation: 2, kind: 'whole', project: FIRST },
    ]);
    second.answerNext();
    expect(record.scheduled).toEqual([FIRST]);
  });

  it('sends a new worker the whole project, and changes only to a worker that holds a project', () => {
    const pool = workerPool();
    const scheduler = createScheduler(pool.create, recorder().listener);
    scheduler.request(FIRST);
    const first = pool.latest();
    first.answerNext();
    scheduler.request(SECOND);
    expect(first.received).toEqual([
      expect.objectContaining({ kind: 'changes', generation: 2, basis: 1 }),
    ]);
    quietly(() => {
      first.port.onmessageerror?.(new MessageEvent('messageerror'));
    });
    expect(pool.latest().received).toEqual([
      { version: SCHEDULE_PROTOCOL_VERSION, generation: 3, kind: 'whole', project: SECOND },
    ]);
  });

  it('replaces a worker whose packed placements cannot be read, asking the new one for the whole project', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    const first = pool.latest();
    first.answerNext();
    scheduler.request(SECOND);
    first.received.shift();
    const unreadable = changes(
      { placements: { ids: ['a'], numbers: Float64Array.from([1, 1, 0]), removed: [] } },
      2,
    );
    const logged = quietly(() => {
      first.port.onmessage?.(new MessageEvent('message', { data: unreadable }));
    });
    expect(logged).toEqual([
      [
        'The schedule worker failed and was restarted:',
        new Error('The schedule worker sent the hour 1, outside the years handled.'),
      ],
    ]);
    expect(record.drops).toEqual([[FIRST]]);
    expect(pool.latest().received).toEqual([
      { version: SCHEDULE_PROTOCOL_VERSION, generation: 3, kind: 'whole', project: SECOND },
    ]);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST, SECOND]);
  });

  it('replaces a worker that sends changes after a schedule that failed, asking the new one for the whole project', () => {
    const pool = workerPool();
    const record = recorder();
    const scheduler = createScheduler(pool.create, record.listener);
    scheduler.request(FIRST);
    const first = pool.latest();
    first.answerNext();
    scheduler.request(SECOND);
    scheduler.request(THIRD);
    first.received.shift();
    const failed = responseWith({ ok: false, error: { kind: 'startDate' } }, 2);
    first.port.onmessage?.(new MessageEvent('message', { data: failed }));
    first.received.shift();
    const logged = quietly(() => {
      first.port.onmessage?.(new MessageEvent('message', { data: changes({}, 3) }));
    });
    expect(logged).toEqual([
      [
        'The schedule worker failed and was restarted:',
        new Error('The schedule worker sent changes to a schedule the page does not hold.'),
      ],
    ]);
    expect(pool.latest().received).toEqual([
      { version: SCHEDULE_PROTOCOL_VERSION, generation: 4, kind: 'whole', project: THIRD },
    ]);
    pool.latest().answerNext();
    expect(record.scheduled).toEqual([FIRST, THIRD]);
  });
});
