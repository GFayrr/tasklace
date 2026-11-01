import type { Session } from 'electron';

const LINUX_PLATFORM = 'linux';

/** Turns spell checking off on Linux, where Electron would download its dictionaries from a Google server the user never chose, and keeps the spell checker of the system elsewhere, which sends nothing. */
export function keepSpellCheckingLocal(
  platform: NodeJS.Platform,
  pageSession: Pick<Session, 'setSpellCheckerEnabled'>,
): void {
  if (platform === LINUX_PLATFORM) {
    pageSession.setSpellCheckerEnabled(false);
  }
}
