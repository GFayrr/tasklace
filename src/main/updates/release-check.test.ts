import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVersion, type Version } from '../../core/version';
import { checkReleases, readReleases, RELEASES_URL, type FetchReleases } from './release-check';

const CURRENT = versionOf('0.1.0');
const MEBIBYTE = 1_048_576;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Reads a version known to be valid, throwing otherwise. */
function versionOf(text: string): Version {
  const version = readVersion(text);
  if (version === null) {
    throw new Error(`${text} is not a version.`);
  }
  return version;
}

/** Describes a release as GitHub lists it. */
function listed(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    html_url: 'https://evil.example',
    ...extra,
  };
}

/** Builds a fetch that answers with a status and a body, recording what was asked. */
function answering(
  body: ConstructorParameters<typeof Response>[0],
  status = 200,
): { readonly fetchReleases: FetchReleases; readonly asked: [string, RequestInit][] } {
  const asked: [string, RequestInit][] = [];
  return {
    asked,
    fetchReleases: (url, init) => {
      asked.push([url, init]);
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

/** Builds a body that sends pieces of bytes, then ends. */
function streamOf(pieces: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(piece);
      }
      controller.close();
    },
  });
}

describe('checkReleases', () => {
  it('asks for the latest releases without cookie, cache or redirect, giving up after a few seconds', async () => {
    const { fetchReleases, asked } = answering(JSON.stringify([]));
    await checkReleases(fetchReleases, CURRENT);
    expect(asked.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/GFayrr/tasklace/releases?per_page=30',
    ]);
    expect(RELEASES_URL).toBe('https://api.github.com/repos/GFayrr/tasklace/releases?per_page=30');
    const [[, init] = ['', {}]] = asked;
    expect({ ...init, signal: init.signal instanceof AbortSignal }).toEqual({
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Tasklace/0.1.0',
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: true,
    });
  });

  it('finds a newer release, and tells when the current version is the latest', async () => {
    const releases = JSON.stringify([listed('v0.3.0-beta.1'), listed('v0.2.0'), listed('v0.1.0')]);
    expect(await checkReleases(answering(releases).fetchReleases, CURRENT)).toEqual({
      kind: 'newer',
      version: '0.3.0-beta.1',
    });
    expect(
      await checkReleases(answering(JSON.stringify([listed('v0.1.0')])).fetchReleases, CURRENT),
    ).toEqual({ kind: 'latest' });
  });

  it('tells when GitHub cannot be reached, logging the cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cause = new TypeError('fetch failed');
    const timedOut = new DOMException('The operation timed out.', 'TimeoutError');
    expect(await checkReleases(() => Promise.reject(cause), CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(await checkReleases(() => Promise.reject(timedOut), CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(warn.mock.calls).toEqual([
      ['The check for new versions could not reach GitHub:', cause],
      ['The check for new versions could not reach GitHub:', timedOut],
    ]);
  });

  it('lets through a thrown value that is not an error', async () => {
    const thrown: unknown = 'not an error';
    /** Fails with a value that is not an error. */
    const throwing: FetchReleases = async () => {
      await Promise.resolve();
      throw thrown;
    };
    await expect(checkReleases(throwing, CURRENT)).rejects.toBe(thrown);
  });

  it('tells when GitHub refuses, logging the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await checkReleases(answering('limit', 403).fetchReleases, CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(await checkReleases(answering(null, 304).fetchReleases, CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(warn.mock.calls).toEqual([
      ['GitHub answered the check for new versions with the status 403.'],
      ['GitHub answered the check for new versions with the status 304.'],
    ]);
  });

  it('stops reading an answer larger than a list of releases can be, before parsing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cancel = vi.fn();
    const quarters = 8;
    let sent = 0;
    const tooLarge = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(MEBIBYTE / 4));
        if (sent === quarters) {
          controller.close();
        }
      },
      cancel,
    });
    expect(await checkReleases(answering(tooLarge).fetchReleases, CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(cancel.mock.calls.length).toBe(1);
    expect(sent).toBeLessThan(quarters);
    expect(warn.mock.calls).toEqual([
      ['GitHub answered the check for new versions with more than 1048576 bytes.'],
    ]);
  });

  it('reads an answer of exactly the largest size allowed', async () => {
    const text = JSON.stringify([listed('v0.2.0')]);
    const padded = text.padEnd(MEBIBYTE, ' ');
    const bytes = new TextEncoder().encode(padded);
    const halves = [bytes.subarray(0, MEBIBYTE / 2), bytes.subarray(MEBIBYTE / 2)];
    expect(await checkReleases(answering(streamOf(halves)).fetchReleases, CURRENT)).toEqual({
      kind: 'newer',
      version: '0.2.0',
    });
  });

  it('tells when an answer stops in the middle, or sends pieces that are not bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cut = new TypeError('terminated');
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cut);
      },
    });
    expect(await checkReleases(answering(broken).fetchReleases, CURRENT)).toEqual({
      kind: 'failed',
    });
    const words = new ReadableStream({
      start(controller) {
        controller.enqueue('not bytes');
        controller.close();
      },
    });
    const wordsResponse = new Response(null, { status: 200 });
    Object.defineProperty(wordsResponse, 'body', { value: words });
    expect(await checkReleases(() => Promise.resolve(wordsResponse), CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(warn.mock.calls).toEqual([
      ['The check for new versions could not reach GitHub:', cut],
      ['GitHub answered the check for new versions with something else than bytes.'],
    ]);
  });

  it('takes a request given up after its time for an unreachable GitHub, and lets through what is a fault of the program', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const late = new DOMException('The operation timed out.', 'TimeoutError');
    expect(await checkReleases(() => Promise.reject(late), CURRENT)).toEqual({ kind: 'failed' });
    expect(warn.mock.calls).toEqual([['The check for new versions could not reach GitHub:', late]]);
    const fault = new RangeError('a fault of the program');
    await expect(checkReleases(() => Promise.reject(fault), CURRENT)).rejects.toBe(fault);
    const other = new DOMException('Data was cloned badly.', 'DataCloneError');
    await expect(checkReleases(() => Promise.reject(other), CURRENT)).rejects.toBe(other);
  });

  it('tells when the answer is not a list of releases, whatever it is', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const body of [
      '{"broken',
      '{}',
      '',
      JSON.stringify(Array.from({ length: 31 }, () => listed('v0.2.0'))),
    ]) {
      expect(
        await checkReleases(answering(body).fetchReleases, CURRENT),
        body.slice(0, 20),
      ).toEqual({
        kind: 'failed',
      });
    }
    expect(await checkReleases(answering(null).fetchReleases, CURRENT)).toEqual({
      kind: 'failed',
    });
    expect(warn.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [
        'GitHub answered the check for new versions with something else than releases.',
      ]),
    );
  });

  it('lets through an error of parsing that is not about the text', async () => {
    const failure = new RangeError('out of memory');
    vi.spyOn(JSON, 'parse').mockImplementation((): unknown => {
      throw failure;
    });
    await expect(checkReleases(answering('[]').fetchReleases, CURRENT)).rejects.toBe(failure);
  });
});

describe('readReleases', () => {
  it('reads the published releases, leaving out drafts and entries that are not releases of Tasklace', () => {
    expect(
      readReleases([
        listed('v0.2.0', { prerelease: false }),
        listed('v0.3.0', { draft: true }),
        listed('v0.4.0', { draft: undefined }),
        listed('0.5.0'),
        listed('v0.6'),
        listed('v0.7.0', { prerelease: 'yes' }),
        { draft: false, prerelease: false },
        null,
        'v0.8.0',
      ]),
    ).toEqual([{ version: readVersion('0.2.0'), markedPreRelease: false }]);
  });

  it('refuses what is not a list, and a list longer than the releases asked for', () => {
    expect(readReleases({ tag_name: 'v0.2.0' })).toBeNull();
    expect(readReleases(null)).toBeNull();
    expect(readReleases(Array.from({ length: 30 }, () => listed('v0.2.0')))).toHaveLength(30);
    expect(readReleases(Array.from({ length: 31 }, () => listed('v0.2.0')))).toBeNull();
  });
});
