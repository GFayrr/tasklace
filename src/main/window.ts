import { BrowserWindow } from 'electron';

const INITIAL_WIDTH = 1280;
const INITIAL_HEIGHT = 800;

/** Creates the application window with every page protection enabled, showing it once its content is ready. */
export function createMainWindow(preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: INITIAL_WIDTH,
    height: INITIAL_HEIGHT,
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
