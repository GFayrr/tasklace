import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import { project, workTask } from '../../core/testing/project-builder';
import { answerScheduleRequest, SCHEDULE_PROTOCOL_VERSION } from './schedule-protocol';
import { createScheduler, type SchedulePort } from './scheduler';

/** A worker that answers only when told to, through the real request handler. */
function manualWorker() {
  const received: unknown[] = [];
  let terminated = false;
  const port: SchedulePort = {
    postMessage: (message) => received.push(message),
    onmessage: null,
    onerror: null,
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
    const worker = manualWorker();
    const record = recorder();
    createScheduler(worker.port, record.listener).request(FIRST);
    worker.answerNext();
    expect(record.scheduled).toEqual([FIRST]);
  });

  it('keeps only the latest project asked while computing, and never shows an older result', () => {
    const worker = manualWorker();
    const record = recorder();
    const scheduler = createScheduler(worker.port, record.listener);
    scheduler.request(FIRST);
    scheduler.request(SECOND);
    scheduler.request(THIRD);
    expect(worker.received).toHaveLength(1);
    worker.answerNext();
    expect(record.scheduled).toEqual([]);
    expect(worker.received).toHaveLength(1);
    worker.answerNext();
    expect(record.scheduled).toEqual([THIRD]);
  });

  it('ignores messages that are not the awaited answer', () => {
    const worker = manualWorker();
    const record = recorder();
    createScheduler(worker.port, record.listener).request(FIRST);
    const stale = { version: SCHEDULE_PROTOCOL_VERSION, generation: 99, result: null };
    worker.port.onmessage?.(new MessageEvent('message', { data: stale }));
    worker.port.onmessage?.(new MessageEvent('message', { data: 'noise' }));
    expect(record.scheduled).toEqual([]);
    worker.answerNext();
    expect(record.scheduled).toEqual([FIRST]);
  });

  it('reports a worker failure and can schedule again afterwards', () => {
    const worker = manualWorker();
    const record = recorder();
    const scheduler = createScheduler(worker.port, record.listener);
    scheduler.request(FIRST);
    worker.received.length = 0;
    const crash = Object.assign(new Event('error'), { message: 'crashed', error: undefined });
    worker.port.onerror?.(crash as ErrorEvent);
    expect(record.failures).toEqual(['crashed']);
    scheduler.request(SECOND);
    worker.answerNext();
    expect(record.scheduled).toEqual([SECOND]);
  });

  it('stops the worker when disposed', () => {
    const worker = manualWorker();
    createScheduler(worker.port, recorder().listener).dispose();
    expect(worker.isTerminated()).toBe(true);
    expect(worker.port.onmessage).toBeNull();
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
