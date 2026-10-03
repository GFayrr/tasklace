import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test';

const CLOSE_LIMIT_MS = 15_000;
const PROBE_LIMIT_MS = 1_000;
const EXIT_LIMIT_MS = 5_000;
const NO_ANSWER = 'no answer';
const CLOSED_TARGET = /closed/i;
const closedApplications = new WeakSet<ElectronApplication>();

/** Launches the application, with its own user data folder when one is given, remembering when it closes, and starts recording a trace, closing it again when the trace cannot start. */
export async function launchApplication(userData?: string): Promise<ElectronApplication> {
  const args = userData === undefined ? ['.'] : ['.', `--user-data-dir=${userData}`];
  const application = await electron.launch({ args });
  application.once('close', () => {
    closedApplications.add(application);
  });
  try {
    await application.context().tracing.start({ screenshots: true, snapshots: true });
  } catch (error) {
    await application.close();
    throw error;
  }
  return application;
}

/** Closes the application unless a test already closed it, answering "Don't save" if it asks whether to save a project that has no file yet, keeping the trace of a failed test, and stopping the process with a description of its state when it does not close in time. */
export async function closeDiscarding(application: ElectronApplication, page: Page): Promise<void> {
  const process = application.process();
  if (
    closedApplications.has(application) ||
    process.exitCode !== null ||
    process.signalCode !== null
  ) {
    return;
  }
  await keepTraceOfFailure(application);
  const closing = application.close();
  void page
    .getByRole('dialog', { name: 'Save this project?' })
    .getByRole('button', { name: "Don't save" })
    .click()
    .catch(reportUnlessClosed);
  const timer = new AbortController();
  let closed: boolean;
  try {
    closed = await Promise.race([
      closing.then(() => true),
      delay(CLOSE_LIMIT_MS, false, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
  if (!closed) {
    await stopStuckApplication(application, page, closing);
  }
}

/** Describes an application that did not close, stops its process and fails the test with that description. */
async function stopStuckApplication(
  application: ElectronApplication,
  page: Page,
  closing: Promise<void>,
): Promise<never> {
  const state = await describeStuckApplication(application, page);
  closing.catch(reportUnlessClosed);
  const process = application.process();
  const exited = new Promise((resolve) => process.once('exit', resolve));
  const killed = process.kill('SIGKILL');
  await Promise.race([exited, delay(EXIT_LIMIT_MS)]);
  throw new Error(
    `The application did not close within ${String(CLOSE_LIMIT_MS)} ms (${state}); stopped=${String(killed)}`,
  );
}

/** Ignores an error that only says the page or application is already closed, and reports any other. */
function reportUnlessClosed(error: unknown): void {
  if (!(error instanceof Error && CLOSED_TARGET.test(error.message))) {
    console.warn('Unexpected error while closing the application:', error);
  }
}

/** Saves the trace of the current test next to its results when it failed, telling when the trace could not be kept, and stops tracing either way. */
async function keepTraceOfFailure(application: ElectronApplication): Promise<void> {
  const info = test.info();
  const failed = info.status !== info.expectedStatus;
  await application
    .context()
    .tracing.stop(failed ? { path: info.outputPath('trace.zip') } : {})
    .catch((error: unknown) => {
      if (failed) {
        console.warn('The trace of the failed test could not be kept:', error);
      }
    });
}

/** Describes what an application that does not close shows: its windows, whether the save question is open and whether its page still answers. */
async function describeStuckApplication(
  application: ElectronApplication,
  page: Page,
): Promise<string> {
  const answer = (probe: Promise<unknown>) =>
    Promise.race([
      probe.then(String, (error: unknown) => `error ${String(error)}`),
      delay(PROBE_LIMIT_MS, NO_ANSWER),
    ]);
  const windows = application.windows().length;
  const prompt = await answer(page.getByRole('dialog', { name: 'Save this project?' }).isVisible());
  const pageState = await answer(page.evaluate(() => document.readyState));
  return `windows=${String(windows)}, save question visible=${prompt}, page=${pageState}`;
}
