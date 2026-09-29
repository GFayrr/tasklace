import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { APP_ENTRY_URL, APP_SCHEME, isAppAddress, resolveAppFile } from './app-files';
import { contentSecurityPolicy } from './content-security-policy';
import { registerIpcHandlers } from './ipc-handlers';
import { CONTENT_SECURITY_POLICY_HEADER, hardenContents, hardenSession } from './security';
import { createMainWindow } from './window';

const NOT_FOUND = 404;
const developmentUrl = app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null);
const developmentOrigin = developmentUrl === null ? null : new URL(developmentUrl).origin;
const policy = contentSecurityPolicy(developmentUrl !== null);
const rendererRoot = join(import.meta.dirname, '../renderer');
const preloadPath = join(import.meta.dirname, '../preload/index.cjs');

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
  app.whenReady().then(start, stop);
} else {
  app.quit();
}

/** Protects the session, serves the interface, answers the bridge and opens the window. */
function start(): void {
  hardenSession(session.defaultSession, policy);
  protocol.handle(APP_SCHEME, serveAppFile);
  registerIpcHandlers((address) => isAppAddress(address, developmentOrigin));
  createMainWindow(preloadPath)
    .loadURL(developmentUrl ?? APP_ENTRY_URL)
    .catch(stop);
}

/** Answers a request of the application scheme with a file of the interface and the content security policy, or not found. */
async function serveAppFile(request: Request): Promise<Response> {
  const file = resolveAppFile(rendererRoot, request.url);
  if (file === null) {
    return new Response(null, { status: NOT_FOUND });
  }
  const headers = { 'Content-Type': file.contentType, [CONTENT_SECURITY_POLICY_HEADER]: policy };
  return readFile(file.path).then(
    (content) => new Response(content, { headers }),
    () => new Response(null, { status: NOT_FOUND }),
  );
}

/** Brings the first window forward when the application is launched a second time. */
function focusFirstWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (window?.isMinimized() === true) {
    window.restore();
  }
  window?.focus();
}

/** Quits after a failure while starting, reporting it on the error output. */
function stop(error: unknown): void {
  console.error(error);
  app.quit();
}
