import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancellableEvent, FakeWebContents } from './testing/fake-electron';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  hardenContents,
  hardenSession,
  openInBrowser,
} from './security';

const openExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());

vi.mock('electron', () => ({ shell: { openExternal } }));

const ALLOWED = 'https://github.com/GFayrr/tasklace/releases';

afterEach(() => {
  openExternal.mockReset();
});

/** Builds a fake session recording the handlers the application gives it. */
function fakeSession() {
  const recorded: {
    permission?: (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    check?: () => boolean;
    headers?: (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders: Record<string, string[]> }) => void,
    ) => void;
  } = {};
  const session = {
    setPermissionRequestHandler: (handler: NonNullable<typeof recorded.permission>) => {
      recorded.permission = handler;
    },
    setPermissionCheckHandler: (handler: NonNullable<typeof recorded.check>) => {
      recorded.check = handler;
    },
    webRequest: {
      onHeadersReceived: (handler: NonNullable<typeof recorded.headers>) => {
        recorded.headers = handler;
      },
    },
  };
  return { session: session as unknown as Session, recorded };
}

describe('hardenSession', () => {
  it('refuses every permission and adds the content security policy to every response', () => {
    const { session, recorded } = fakeSession();
    hardenSession(session, "default-src 'self'");
    const granted: boolean[] = [];
    recorded.permission?.({}, 'camera', (answer) => granted.push(answer));
    expect(granted).toEqual([false]);
    expect(recorded.check?.()).toBe(false);
    const responses: Record<string, string[]>[] = [];
    recorded.headers?.({ responseHeaders: { 'X-Kept': ['yes'] } }, ({ responseHeaders }) =>
      responses.push(responseHeaders),
    );
    recorded.headers?.({}, ({ responseHeaders }) => responses.push(responseHeaders));
    expect(responses).toEqual([
      { 'X-Kept': ['yes'], [CONTENT_SECURITY_POLICY_HEADER]: ["default-src 'self'"] },
      { [CONTENT_SECURITY_POLICY_HEADER]: ["default-src 'self'"] },
    ]);
  });
});

describe('hardenContents', () => {
  /** Hardens a fake page and returns it with its window-opening handler. */
  function hardened() {
    const contents = new FakeWebContents();
    let openHandler: (details: { url: string }) => { action: string } = () => ({ action: 'allow' });
    Object.assign(contents, {
      setWindowOpenHandler: (handler: typeof openHandler) => {
        openHandler = handler;
      },
    });
    hardenContents(contents as unknown as WebContents);
    return { contents, open: (url: string) => openHandler({ url }) };
  }

  it.each(['will-navigate', 'will-redirect', 'will-attach-webview'])('refuses %s', (name) => {
    const { contents } = hardened();
    const event = cancellableEvent();
    contents.emit(name, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('never opens a new window, sending an allowed link to the browser instead', () => {
    openExternal.mockResolvedValue();
    const { open } = hardened();
    expect(open(ALLOWED)).toEqual({ action: 'deny' });
    expect(open('https://example.com/')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(ALLOWED);
  });
});

describe('openInBrowser', () => {
  it('tells whether the system could open the address', async () => {
    openExternal.mockResolvedValueOnce();
    expect(await openInBrowser(ALLOWED)).toBe(true);
    openExternal.mockRejectedValueOnce(new Error('no browser'));
    expect(await openInBrowser(ALLOWED)).toBe(false);
  });

  it('lets a failure that is not an error through', async () => {
    openExternal.mockRejectedValueOnce('broken');
    await expect(openInBrowser(ALLOWED)).rejects.toBe('broken');
  });
});
