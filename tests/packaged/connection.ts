import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from '@playwright/test';

const CONNECT_ATTEMPTS = 60;
const CONNECT_STEP_MS = 500;
const KEPT_ERROR_CHARACTERS = 4096;

/** Finds a free port on this computer for the debugging connection. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') {
    throw new Error('No port could be found for the debugging connection.');
  }
  return address.port;
}

/** Tells whether a process has ended. */
function hasEnded(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Keeps the end of what a process writes as errors and gives a sentence that tells how it ended, so that a failed start of Chromium, such as its sandbox refusing to run, tells its cause. */
export function watchEnding(child: ChildProcess): () => string {
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-KEPT_ERROR_CHARACTERS);
  });
  return () =>
    `Exit code ${String(child.exitCode)}, signal ${String(child.signalCode)}, errors: ${errors}`;
}

/** Connects to the window of a running application through the debugging port of Chromium, since its fuses refuse the Node inspector that Playwright uses for Electron, or gives null when no window comes or the application ends first. */
export async function connectToWindow(
  port: number,
  child: ChildProcess,
): Promise<{ readonly browser: Browser; readonly page: Page } | null> {
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !hasEnded(child); attempt += 1) {
    const browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${String(port)}`)
      .catch(() => null);
    const page = browser?.contexts()[0]?.pages()[0];
    if (browser !== null && page !== undefined) {
      return { browser, page };
    }
    await browser?.close();
    await delay(CONNECT_STEP_MS);
  }
  return null;
}
