import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { Bonjour } from 'bonjour-service';
import { app, BrowserWindow, clipboard, dialog, protocol, safeStorage, session } from 'electron';
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  createAppFileServer,
  createPrintPageStore,
  isAppAddress,
} from './app-files';
import { MAX_PDF_RENDER_MILLISECONDS } from '../core/limits';
import { registerCollaborationHandlers, systemTimer } from './collaboration/collaboration-service';
import { createRelayLinkStore, vaultOf } from './collaboration/relay/relay-links';
import { registerRelayHandlers } from './collaboration/relay/relay-service';
import { mdnsOf } from './collaboration/discovery';
import { contentSecurityPolicy } from './content-security-policy';
import { flushBeforeClosing, registerFlushHandler } from './close-flush';
import { runInFileWorker, startFileWorker } from './file-worker-client';
import { createTrustCheck } from './ipc-trust';
import {
  forgetWindowProject,
  registerProjectFileHandlers,
  windowDocumentOf,
  windowProjectKind,
} from './project-files';
import { CONTENT_SECURITY_POLICY_HEADER, hardenContents, hardenSession } from './security';
import { MESSAGES } from './messages';
import { installApplicationMenu } from './platform/application-menu';
import {
  captureConsole,
  createLogFile,
  logChildProcessesGone,
  logPageMessages,
  logProcessErrors,
  logWorkerErrors,
  writeLogBeforeQuitting,
} from './log-file';
import { createMainWindow, createPrintWindow } from './window';
import { printFontsIn, registerPdfHandlers } from './pdf-export';

const developmentUrl = app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null);
const developmentOrigin = developmentUrl === null ? null : new URL(developmentUrl).origin;
const policy = contentSecurityPolicy(developmentUrl !== null);
const rendererRoot = join(import.meta.dirname, '../renderer');
const preloadPath = join(import.meta.dirname, '../preload/index.cjs');
const fileWorkerPath = join(import.meta.dirname, 'file-worker.js');
const EXIT_AFTER_FAILURE = 1;
const LOG_FOLDER = 'logs';
const RELAY_LINK_STORE = 'relay-links.json';
const log = createLogFile(
  join(app.getPath('userData'), LOG_FOLDER),
  () => new Date(),
  reportLogFailure,
);
captureConsole(console, log);
logProcessErrors(process);
logChildProcessesGone(app);
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

/** Protects the session, serves the interface and the pages printed to PDF, answers the bridge and opens the window, which saves its project before closing. */
function start(): void {
  hardenSession(session.defaultSession, policy);
  const printPages = createPrintPageStore();
  protocol.handle(
    APP_SCHEME,
    createAppFileServer(rendererRoot, { [CONTENT_SECURITY_POLICY_HEADER]: policy }, printPages),
  );
  const assertTrusted = createTrustCheck((address) => isAppAddress(address, developmentOrigin));
  registerFlushHandler(assertTrusted);
  registerProjectFileHandlers({
    assertTrusted,
    runTask: (task) => runInFileWorker(createFileWorker, task),
    userDataFolder: app.getPath('userData'),
  });
  const pdf = registerPdfHandlers({
    assertTrusted,
    pages: printPages,
    createPrintWindow,
    timeoutMs: MAX_PDF_RENDER_MILLISECONDS,
    runTask: (task) => runInFileWorker(createFileWorker, task),
    fonts: printFontsIn(join(rendererRoot, 'fonts')),
  });
  const collaboration = registerCollaborationHandlers({
    assertTrusted,
    userDataFolder: app.getPath('userData'),
    runTask: (task) => runInFileWorker(createFileWorker, task),
    createMdns,
    copyText: (text) => clipboard.writeText(text),
    sharesElsewhere: (sender) => relay.isSharing(sender),
    leaveElsewhere: (sender) => relay.leave(sender),
  });
  const relay = registerRelayHandlers({
    assertTrusted,
    runTask: (task) => runInFileWorker(createFileWorker, task),
    links: createRelayLinkStore(
      join(app.getPath('userData'), RELAY_LINK_STORE),
      vaultOf(safeStorage, process.platform),
    ),
    documentOf: windowDocumentOf,
    busyElsewhere: (sender) => collaboration.isBusy(sender),
    startTimer: systemTimer,
  });
  installApplicationMenu(process.platform);
  const window = createMainWindow(preloadPath);
  logPageMessages(window.webContents, log);
  flushBeforeClosing(
    window,
    windowProjectKind,
    (sender) => {
      forgetWindowProject(sender);
      pdf.forgetHeldPdf(sender);
      collaboration.forgetWindow(sender);
      relay.forgetWindow(sender);
    },
    (sender) => {
      collaboration.forgetWindow(sender);
      relay.forgetWindow(sender);
    },
  );
  const contents = window.webContents;
  window.once('closed', () => {
    collaboration.forgetWindow(contents);
    relay.forgetWindow(contents);
  });
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

/** Starts a worker for one file task, what it reports as errors going to the log. */
function createFileWorker(): Worker {
  return startFileWorker(fileWorkerPath, (stderr) => {
    logWorkerErrors(stderr, log, process.stderr);
  });
}

/** Starts the mDNS of the application, an error of its network being only logged since people can still type the address of a host. */
function createMdns(): ReturnType<
  Parameters<typeof registerCollaborationHandlers>[0]['createMdns']
> {
  const bonjour = new Bonjour(undefined, (error: unknown) => {
    console.warn('The search for shared plans on the network failed:', error);
  });
  return {
    mdns: mdnsOf(bonjour),
    destroy: () => {
      bonjour.destroy();
    },
  };
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
