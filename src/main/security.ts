import { shell, type Session, type WebContents } from 'electron';
import { isAllowedExternalUrl } from './external-links';

export const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';

/** Refuses every permission a page asks for and adds the content security policy to every response of a session. */
export function hardenSession(session: Session, policy: string): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = {
      ...details.responseHeaders,
      [CONTENT_SECURITY_POLICY_HEADER]: [policy],
    };
    callback({ responseHeaders });
  });
}

/** Keeps a page on the application: navigation, embedded pages and new windows are refused, an allowed https link opening in the browser instead. */
export function hardenContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void openInBrowser(url);
    }
    return { action: 'deny' };
  });
}

/** Opens an allowed address in the browser, telling whether the system could open it. */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      console.error('The browser could not open an address:', error);
      return false;
    }
    throw error;
  }
}
