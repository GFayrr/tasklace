import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, dialog, protocol, session } from 'electron';
import { APP_ENTRY_URL, APP_SCHEME, createAppFileServer, isAppAddress } from './app-files';
import { MAX_FILE_WORKER_HEAP_MEBIBYTES } from '../core/limits';
import { contentSecurityPolicy } from './content-security-policy';
import { flushBeforeClosing, registerFlushHandler } from './close-flush';
import { runInFileWorker } from './file-worker-client';
import { createTrustCheck } from './ipc-trust';
import {
  forgetWindowProject,
  registerProjectFileHandlers,
  windowProjectKind,
} from './project-files';
import { CONTENT_SECURITY_POLICY_HEADER, hardenContents, hardenSession } from './security';
import { MESSAGES } from './messages';
import { installApplicationMenu } from './platform/application-menu';
import {
  captureConsole,
  createLogFile,
  logPageMessages,
  logProcessErrors,
  logWorkerErrors,
  writeLogBeforeQuitting,
} from './log-file';
import { createMainWindow } from './window';

const developmentUrl = app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null);
const developmentOrigin = developmentUrl === null ? null : new URL(developmentUrl).origin;
const policy = contentSecurityPolicy(developmentUrl !== null);
const rendererRoot = join(import.meta.dirname, '../renderer');
const preloadPath = join(import.meta.dirname, '../preload/index.cjs');
const fileWorkerPath = join(import.meta.dirname, 'file-worker.js');
const EXIT_AFTER_FAILURE = 1;
const LOG_FOLDER = 'logs';
const log = createLogFile(
  join(app.getPath('userData'), LOG_FOLDER),
  () => new Date(),
  reportLogFailure,
);
captureConsole(console, log);
logProcessErrors(process);
writeLogBeforeQuitting(app, log);

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', focusFirstWindow);
  app.on('web-contents-created', (_event, contents) => {
    hardenContents(contents);
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.whenReady().then(start).catch(stop);
} else {
  app.quit();
}

/** Protects the session, serves the interface, answers the bridge and opens the window, which saves its project before closing. */
function start(): void {
  hardenSession(session.defaultSession, policy);
  protocol.handle(
    APP_SCHEME,
    createAppFileServer(rendererRoot, { [CONTENT_SECURITY_POLICY_HEADER]: policy }),
  );
  const assertTrusted = createTrustCheck((address) => isAppAddress(address, developmentOrigin));
  registerFlushHandler(assertTrusted);
  registerProjectFileHandlers({
    assertTrusted,
    runTask: (task) => runInFileWorker(createFileWorker, task),
    userDataFolder: app.getPath('userData'),
  });
  installApplicationMenu(process.platform);
  const window = createMainWindow(preloadPath);
  logPageMessages(window.webContents, log);
  flushBeforeClosing(window, windowProjectKind, forgetWindowProject);
  let closing = false;
  window.once('close', () => {
    closing = true;
  });
  window.loadURL(developmentUrl ?? APP_ENTRY_URL).catch((error: unknown) => {
    if (closing || window.isDestroyed()) {
      console.warn('The interface stopped loading because its window was closed:', error);
      return;
    }
    stop(error);
  });
}

/** Starts a worker for one file task, with the memory limit that keeps a forged file from exhausting the application, what it reports as errors going to the log. */
function createFileWorker(): Worker {
  const worker = new Worker(fileWorkerPath, {
    resourceLimits: { maxOldGenerationSizeMb: MAX_FILE_WORKER_HEAP_MEBIBYTES },
    stderr: true,
  });
  logWorkerErrors(worker.stderr, log, process.stderr);
  return worker;
}

/** Brings the first window forward when the application is launched a second time. */
function focusFirstWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (window?.isMinimized() === true) {
    window.restore();
  }
  window?.focus();
}

/** Quits after a failure while starting, telling the user in an error box and logging the cause, its windows being destroyed so that a page that does not answer cannot hold the application open. */
function stop(error: unknown): void {
  console.error('Tasklace could not start:', error);
  dialog.showErrorBox(MESSAGES.startup.failedTitle, MESSAGES.startup.failedBody);
  for (const window of BrowserWindow.getAllWindows()) {
    window.destroy();
  }
  void log.written().finally(() => {
    app.exit(EXIT_AFTER_FAILURE);
  });
}

/** Reports on the error output that the log file could not be written. */
function reportLogFailure(error: unknown): void {
  process.stderr.write(`The log file could not be written: ${String(error)}\n`);
}
