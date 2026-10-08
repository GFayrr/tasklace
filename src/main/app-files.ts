import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { isMissingFile } from './stored-files';

export const APP_SCHEME = 'app';
export const APP_HOST = 'tasklace';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface AppFile {
  readonly path: string;
  readonly contentType: string;
}

/** Tells whether an address belongs to the application: its own scheme, or the development server when one is used. */
export function isAppAddress(address: string, developmentOrigin: string | null): boolean {
  if (!URL.canParse(address)) {
    return false;
  }
  const url = new URL(address);
  const isBundled = url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  return isBundled || (developmentOrigin !== null && url.origin === developmentOrigin);
}

/** Finds the file of the renderer folder an application address points at, refusing any other scheme, host, unknown type or path leaving the folder. */
export function resolveAppFile(rendererRoot: string, address: string): AppFile | null {
  if (!URL.canParse(address)) {
    return null;
  }
  const url = new URL(address);
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
    return null;
  }
  const pathname = decodePath(url.pathname);
  if (pathname === null) {
    return null;
  }
  const root = resolve(rendererRoot);
  const path = resolve(root, `.${pathname}`);
  const inside = relative(root, path);
  const contentType = CONTENT_TYPES[extname(path)];
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || contentType === undefined) {
    return null;
  }
  return { path, contentType };
}

/** Decodes the escaped characters of an address path, or returns null when an escape is malformed. */
function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

const NOT_FOUND = 404;

/** Creates the handler of the application scheme, answering with a file of the interface, its type and the security headers, or not found for an address outside the interface or an unreadable file, logged when it exists. */
export function createAppFileServer(
  rendererRoot: string,
  securityHeaders: Readonly<Record<string, string>>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const file = resolveAppFile(rendererRoot, request.url);
    if (file === null) {
      return new Response(null, { status: NOT_FOUND });
    }
    const headers = { 'Content-Type': file.contentType, ...securityHeaders };
    return readFile(file.path).then(
      (content) => new Response(content, { headers }),
      (error: unknown) => {
        if (!isMissingFile(error)) {
          console.error('A file of the interface could not be read:', error);
        }
        return new Response(null, { status: NOT_FOUND });
      },
    );
  };
}
