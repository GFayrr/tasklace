import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'node:util';
import type { Readable } from 'node:stream';
import type { WebContents } from 'electron';
import { MAX_LOG_BYTES, MAX_LOG_ENTRY_LENGTH } from '../core/limits';
import { createSerialQueue } from './serial-queue';
import { isMissingFile } from './stored-files';

export type LogLevel = 'error' | 'warning';

export interface LogFile {
  readonly write: (level: LogLevel, text: string) => void;
  readonly written: () => Promise<void>;
}

export interface LogConsole {
  error: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
}

const LOG_NAME = 'tasklace.log';
const PREVIOUS_LOG_NAME = 'tasklace.previous.log';
const LINE_BREAKS = /\r\n|\r|\n/g;
const LINE_SEPARATOR = ' | ';
const ENCODER = new TextEncoder();

/** Keeps a log file in a folder, appending one dated line per entry, one write at a time, and setting the log aside under another name once it would grow past its limit, a failure being reported on the error output and a log that cannot be set aside growing until the next attempt, a limit further. */
export function createLogFile(
  folder: string,
  now: () => Date,
  reportFailure: (error: unknown) => void,
): LogFile {
  const path = join(folder, LOG_NAME);
  const previousPath = join(folder, PREVIOUS_LOG_NAME);
  const runInOrder = createSerialQueue();
  let size: number | null = null;
  let last: Promise<void> = Promise.resolve();
  const append = async (line: string): Promise<void> => {
    const bytes = ENCODER.encode(line).length;
    size ??= await prepare(folder, path);
    if (size + bytes > MAX_LOG_BYTES) {
      size = 0;
      await rename(path, previousPath).catch(reportFailure);
    }
    await appendFile(path, line);
    size += bytes;
  };
  return {
    write: (level, text) => {
      const line = logLine(now(), level, text);
      last = runInOrder(() => append(line)).catch(reportFailure);
    },
    written: () => last,
  };
}

/** Writes an entry as a single line: its instant, its level, then its text without line breaks and within the length limit. */
export function logLine(instant: Date, level: LogLevel, text: string): string {
  const flat = text.replace(LINE_BREAKS, LINE_SEPARATOR).slice(0, MAX_LOG_ENTRY_LENGTH);
  return `${instant.toISOString()} ${level.toUpperCase()} ${flat}\n`;
}

/** Copies what a console reports as errors and warnings into the log, the console still showing it. */
export function captureConsole(target: LogConsole, log: LogFile): void {
  const { error, warn } = target;
  target.error = (...values) => {
    error(...values);
    log.write('error', format(...values));
  };
  target.warn = (...values) => {
    warn(...values);
    log.write('warning', format(...values));
  };
}

export interface ProcessErrorSource {
  on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/** Logs the exceptions the main process does not catch and the promises it leaves rejected, without changing how the process reacts to them. */
export function logProcessErrors(source: ProcessErrorSource): void {
  source.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error(`Uncaught exception in the main process (${origin}):`, error);
  });
  source.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in the main process:', reason);
  });
}

/** Copies into the log the errors and warnings a page writes to its console. */
export function logPageMessages(contents: WebContents, log: LogFile): void {
  contents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'error' || level === 'warning') {
      log.write(level, `Page: ${message} (${sourceId}:${String(lineNumber)})`);
    }
  });
}

/** Copies into the log, and onto the error output, what a worker writes on its error output. */
export function logWorkerErrors(
  stream: Readable,
  log: LogFile,
  output: NodeJS.WritableStream,
): void {
  stream.setEncoding('utf8');
  stream.on('data', (text: string) => {
    output.write(text);
    log.write('error', `Worker: ${text.trimEnd()}`);
  });
}

/** Creates the folder of the log and returns the size of the log already there, none when it is missing. */
async function prepare(folder: string, path: string): Promise<number> {
  await mkdir(folder, { recursive: true });
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    throw error;
  }
}
