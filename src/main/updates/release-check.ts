import {
  MAX_RELEASES_RESPONSE_BYTES,
  RELEASE_CHECK_MILLISECONDS,
  RELEASES_PER_CHECK,
} from '../../core/limits';
import {
  formatVersion,
  newestRelease,
  readVersion,
  type PublishedRelease,
  type Version,
} from '../../core/version';
import type { ReleaseCheck } from '../../preload/bridge-contract';

export type FetchReleases = (url: string, init: RequestInit) => Promise<Response>;

export const RELEASES_URL = `https://api.github.com/repos/GFayrr/tasklace/releases?per_page=${String(RELEASES_PER_CHECK)}`;

const OK_STATUS = 200;
const RELEASE_TAG_PREFIX = 'v';
const NOT_BYTES = Symbol('not bytes');
const NETWORK_ABORTS: readonly string[] = ['TimeoutError', 'AbortError'];

/** Asks GitHub for the latest releases of Tasklace and tells whether one is newer than the current version, reading the answer as untrusted and telling why the check failed, each failure being logged. */
export async function checkReleases(
  fetchReleases: FetchReleases,
  current: Version,
): Promise<ReleaseCheck> {
  let response: Response;
  try {
    response = await fetchReleases(RELEASES_URL, requestOf(current));
  } catch (error) {
    return unreachable(error);
  }
  if (response.status !== OK_STATUS) {
    await response.body?.cancel();
    console.warn(
      `GitHub answered the check for new versions with the status ${String(response.status)}.`,
    );
    return { kind: 'failed' };
  }
  let text: string | typeof NOT_BYTES | null;
  try {
    text = await readCapped(response);
  } catch (error) {
    return unreachable(error);
  }
  if (text === NOT_BYTES) {
    console.warn('GitHub answered the check for new versions with something else than bytes.');
    return { kind: 'failed' };
  }
  return text === null ? tooLarge() : checkOf(text, current);
}

/** Builds the request for the releases: no cookie, no cache, no redirect, and given up after a few seconds. */
function requestOf(current: Version): RequestInit {
  return {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `Tasklace/${formatVersion(current)}`,
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(RELEASE_CHECK_MILLISECONDS),
  };
}

/** Logs that GitHub could not be reached, as a failed connection, a refused redirection or a request given up after its time, and tells so, letting through any other thrown value, which is a fault of the program. */
function unreachable(error: unknown): ReleaseCheck {
  if (!isNetworkFailure(error)) {
    throw error;
  }
  console.warn('The check for new versions could not reach GitHub:', error);
  return { kind: 'failed' };
}

/** Tells whether a value thrown by a request comes from the network: the error a fetch throws for a failed connection or a refused redirection, or the one of a request aborted after its time. */
function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && NETWORK_ABORTS.includes(error.name))
  );
}

/** Logs an answer too large to be a list of releases and tells so. */
function tooLarge(): ReleaseCheck {
  console.warn(
    `GitHub answered the check for new versions with more than ${String(MAX_RELEASES_RESPONSE_BYTES)} bytes.`,
  );
  return { kind: 'failed' };
}

/** Reads the text of an answer, stopping and returning null as soon as it grows beyond the size a list of releases can have, or a mark when a piece of it is not bytes. */
async function readCapped(response: Response): Promise<string | typeof NOT_BYTES | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk: unknown = read.value;
    if (!(chunk instanceof Uint8Array)) {
      await reader.cancel();
      return NOT_BYTES;
    }
    size += chunk.length;
    if (size > MAX_RELEASES_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Tells what an answer of GitHub says about new versions, logging an answer that is not a list of releases. */
function checkOf(text: string, current: Version): ReleaseCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    value = null;
  }
  const releases = readReleases(value);
  if (releases === null) {
    console.warn('GitHub answered the check for new versions with something else than releases.');
    return { kind: 'failed' };
  }
  const newest = newestRelease(releases, current);
  return newest === null ? { kind: 'latest' } : { kind: 'newer', version: formatVersion(newest) };
}

/** Reads the published releases of an untrusted answer, leaving out drafts and entries that are not a release of Tasklace, or returns null when the answer is not a list of at most the releases asked for. */
export function readReleases(value: unknown): PublishedRelease[] | null {
  if (!Array.isArray(value) || value.length > RELEASES_PER_CHECK) {
    return null;
  }
  return value.flatMap((entry: unknown) => {
    const release = releaseOf(entry);
    return release === null ? [] : [release];
  });
}

/** Reads one published release of the answer, or returns null for a draft or an entry whose tag is not a version. */
function releaseOf(entry: unknown): PublishedRelease | null {
  const tag: unknown = Reflect.get(Object(entry), 'tag_name');
  const draft: unknown = Reflect.get(Object(entry), 'draft');
  const markedPreRelease: unknown = Reflect.get(Object(entry), 'prerelease');
  if (
    typeof tag !== 'string' ||
    !tag.startsWith(RELEASE_TAG_PREFIX) ||
    draft !== false ||
    typeof markedPreRelease !== 'boolean'
  ) {
    return null;
  }
  const version = readVersion(tag);
  return version === null ? null : { version, markedPreRelease };
}
