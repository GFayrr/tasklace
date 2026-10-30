import { BrowserWindow } from 'electron';

const INITIAL_WIDTH = 1280;
const INITIAL_HEIGHT = 800;

/** Creates the application window with its icon and every page protection enabled, showing it once its content is ready. */
export function createMainWindow(preloadPath: string, iconPath: string): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: INITIAL_WIDTH,
    height: INITIAL_HEIGHT,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      experimentalFeatures: false,
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  return window;
}

/** Creates the hidden window that prints a page to PDF, with no bridge and no script allowed, since it only lays out the drawing it is given. */
export function createPrintWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      javascript: false,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
}
