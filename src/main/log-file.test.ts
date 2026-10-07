import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOG_BYTES, MAX_LOG_ENTRY_LENGTH } from '../core/limits';
import {
  captureConsole,
  createLogFile,
  logLine,
  logPageMessages,
  logProcessErrors,
  logWorkerErrors,
  type LogConsole,
  type LogFile,
  writeLogBeforeQuitting,
} from './log-file';
import { FakeWebContents } from './testing/fake-electron';

const INSTANT = new Date(Date.UTC(2026, 9, 3, 12, 30));
const STAMP = '2026-10-03T12:30:00.000Z';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-log-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A log that records its entries in memory. */
function memoryLog(): LogFile & { readonly entries: string[] } {
  const entries: string[] = [];
  return {
    entries,
    write: (level, text) => entries.push(`${level}: ${text}`),
    written: () => Promise.resolve(),
  };
}

describe('logLine', () => {
  it('writes one dated line per entry, without line breaks and within the length limit', () => {
    expect(logLine(INSTANT, 'error', 'first\r\nsecond\nthird\rfourth')).toBe(
      `${STAMP} ERROR first | second | third | fourth\n`,
    );
    const long = logLine(INSTANT, 'warning', 'x'.repeat(MAX_LOG_ENTRY_LENGTH + 10));
    expect(long).toBe(`${STAMP} WARNING ${'x'.repeat(MAX_LOG_ENTRY_LENGTH)}\n`);
  });
});

describe('createLogFile', () => {
  it('creates its folder and appends the entries in order, after what the log already holds', async () => {
    const logs = join(folder, 'logs');
    const failures: unknown[] = [];
    const log = createLogFile(
      logs,
      () => INSTANT,
      (error) => failures.push(error),
    );
    log.write('error', 'first');
    log.write('warning', 'second');
    await log.written();
    const again = createLogFile(
      logs,
      () => INSTANT,
      (error) => failures.push(error),
    );
    again.write('error', 'third');
    await again.written();
    expect(await readFile(join(logs, 'tasklace.log'), 'utf8')).toBe(
      `${STAMP} ERROR first\n${STAMP} WARNING second\n${STAMP} ERROR third\n`,
    );
    expect(failures).toEqual([]);
  });

  it('sets the log aside once it would grow past its limit, replacing the one set aside before', async () => {
    await writeFile(join(folder, 'tasklace.log'), 'a'.repeat(MAX_LOG_BYTES - 10));
    await writeFile(join(folder, 'tasklace.previous.log'), 'older');
    const log = createLogFile(
      folder,
      () => INSTANT,
      () => undefined,
    );
    log.write('error', 'too much');
    await log.written();
    expect(await readFile(join(folder, 'tasklace.previous.log'), 'utf8')).toHaveLength(
      MAX_LOG_BYTES - 10,
    );
    expect(await readFile(join(folder, 'tasklace.log'), 'utf8')).toBe(`${STAMP} ERROR too much\n`);
  });

  it('reports a log that cannot be written, then tries again at the next entry', async () => {
    const blocking = join(folder, 'a-file');
    await writeFile(blocking, '');
    const failures: unknown[] = [];
    const log = createLogFile(
      join(blocking, 'logs'),
      () => INSTANT,
      (error) => failures.push(error),
    );
    log.write('error', 'lost');
    log.write('error', 'lost too');
    await log.written();
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('captureConsole', () => {
  it('copies errors and warnings into the log, the console still showing them', () => {
    const shown: unknown[][] = [];
    const target: LogConsole = {
      error: (...values) => shown.push(['error', ...values]),
      warn: (...values) => shown.push(['warn', ...values]),
    };
    const log = memoryLog();
    captureConsole(target, log);
    target.error('Failed:', { code: 'EACCES' });
    target.warn('Careful', 3);
    expect(shown).toEqual([
      ['error', 'Failed:', { code: 'EACCES' }],
      ['warn', 'Careful', 3],
    ]);
    expect(log.entries).toEqual(["error: Failed: { code: 'EACCES' }", 'warning: Careful 3']);
  });
});

describe('logProcessErrors', () => {
  it('logs the uncaught exceptions and unhandled rejections of the main process with their cause', () => {
    const source = new EventEmitter();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logProcessErrors(source);
      const error = new Error('uncaught');
      source.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
      source.emit('unhandledRejection', 'refused');
      expect(logged.mock.calls).toEqual([
        ['Uncaught exception in the main process (uncaughtException):', error],
        ['Unhandled rejection in the main process:', 'refused'],
      ]);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('logPageMessages', () => {
  it('copies the errors and warnings of a page into the log, leaving out its other messages', () => {
    const contents = new FakeWebContents();
    const log = memoryLog();
    logPageMessages(contents as unknown as WebContents, log);
    const message = (level: string, text: string) => {
      contents.emit('console-message', {
        level,
        message: text,
        sourceId: 'app://main.js',
        lineNumber: 7,
      });
    };
    message('error', 'Broken');
    message('warning', 'Odd');
    message('info', 'Fine');
    message('debug', 'Detail');
    expect(log.entries).toEqual([
      'error: Page: Broken (app://main.js:7)',
      'warning: Page: Odd (app://main.js:7)',
    ]);
  });
});

describe('logWorkerErrors', () => {
  it('copies what a worker writes on its error output into the log and onto the error output', () => {
    const stream = new PassThrough();
    const output = new PassThrough();
    const shown: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (text: string) => shown.push(text));
    const log = memoryLog();
    logWorkerErrors(stream, log, output);
    stream.write('Read failed\n');
    expect(log.entries).toEqual(['error: Worker: Read failed']);
    expect(shown).toEqual(['Read failed\n']);
  });
});

describe('writeLogBeforeQuitting', () => {
  it('holds the end of the application once, until the log has written what it was given', async () => {
    const listeners: ((event: { preventDefault: () => void }) => void)[] = [];
    let quits = 0;
    let release: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeLogBeforeQuitting(
      {
        on: (_event, listener) => listeners.push(listener),
        quit: () => {
          quits += 1;
        },
      },
      { write: () => undefined, written: () => written },
    );
    const quitting = (): boolean => {
      let held = false;
      for (const listener of listeners) {
        listener({
          preventDefault: () => {
            held = true;
          },
        });
      }
      return held;
    };
    expect(quitting()).toBe(true);
    expect(quits).toBe(0);
    release();
    await written;
    await Promise.resolve();
    expect(quits).toBe(1);
    expect(quitting()).toBe(false);
  });
});
