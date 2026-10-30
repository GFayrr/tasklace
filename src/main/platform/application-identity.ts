import type { App } from 'electron';

export const APPLICATION_USER_MODEL_ID = 'io.github.gfayrr.tasklace';

const WINDOWS_PLATFORM = 'win32';

/** Gives the application its identifier on Windows, which groups its windows on the taskbar and names it in notifications. */
export function setApplicationIdentity(
  platform: NodeJS.Platform,
  application: Pick<App, 'setAppUserModelId'>,
): void {
  if (platform === WINDOWS_PLATFORM) {
    application.setAppUserModelId(APPLICATION_USER_MODEL_ID);
  }
}
