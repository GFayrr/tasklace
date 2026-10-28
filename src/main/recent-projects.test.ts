import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_PATH_LENGTH, MAX_RECENT_PROJECTS } from '../core/limits';
import {
  formatRecentProjects,
  noteRecentRelay,
  readRecentProjects,
  readRecentStore,
  recordRecentProject,
  withRecentProject,
  withRelayOf,
  type RecentEntry,
} from './recent-projects';

const writing = vi.hoisted((): { failure: Error | null } => ({ failure: null }));

vi.mock('./safe-write', async (importOriginal) => {
  const original = await importOriginal<typeof import('./safe-write')>();
  return {
    ...original,
    writeFileSafely: (...values: Parameters<typeof original.writeFileSafely>) =>
      writing.failure === null
        ? original.writeFileSafely(...values)
        : Promise.reject(writing.failure),
  };
});

const A = resolve('/projects/a.tasklace');
const B = resolve('/projects/b.tasklace');
const C = resolve('/projects/c.tasklace');
const D = resolve('/projects/d.tasklace');
const RELAY = 'relay.example:8443';

/** Gives the entries of projects shared through no relay. */
function local(...paths: string[]): RecentEntry[] {
  return paths.map((path) => ({ path, relay: null }));
}

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-recent-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('recent projects', () => {
  it('puts the last opened project first, without duplicate, keeping only the limit', () => {
    expect(withRecentProject(local(A, B, C), B)).toEqual(local(B, A, C));
    expect(withRecentProject(local(A, B, C), D)).toEqual(local(D, A, B));
    expect(withRecentProject(local(A, B, C), D)).toHaveLength(MAX_RECENT_PROJECTS);
  });

  it('lists a project once whatever way its path is written, in the store or when recorded', () => {
    const unnormalized = A.replace('a.tasklace', join('.', 'x', '..', 'a.tasklace'));
    expect(withRecentProject(local(A, B), unnormalized)).toEqual(local(A, B));
    expect(readRecentStore(formatRecentProjects(local(A, B, A, unnormalized, C)))).toEqual({
      entries: local(A, B, C),
      damaged: false,
    });
  });

  it('reads back what it writes', () => {
    const shared = [{ path: A, relay: RELAY }, ...local(B)];
    expect(readRecentStore(formatRecentProjects(shared))).toEqual({
      entries: shared,
      damaged: false,
    });
    expect(readRecentStore('')).toEqual({ entries: [], damaged: false });
  });

  it.each([
    'not json',
    '[]',
    'null',
    JSON.stringify({ version: 3, projects: local(A) }),
    JSON.stringify({ version: 2, paths: [A] }),
    JSON.stringify({ version: 1, paths: 'a' }),
    JSON.stringify({ version: 1, projects: local(A) }),
  ])('reads the damaged store %j as empty and damaged', (text) => {
    expect(readRecentStore(text)).toEqual({ entries: [], damaged: true });
  });

  it('keeps only well-formed absolute paths, within the limit, telling that some were dropped', () => {
    const text = JSON.stringify({
      version: 1,
      paths: [
        'relative.tasklace',
        42,
        `${A}\0x`,
        `/${'a'.repeat(MAX_FILE_PATH_LENGTH)}`,
        A,
        B,
        C,
        D,
      ],
    });
    expect(readRecentStore(text)).toEqual({ entries: local(A, B, C), damaged: true });
    const tooMany = formatRecentProjects(local(A, B, C, D));
    expect(readRecentStore(tooMany)).toEqual({ entries: local(A, B, C), damaged: false });
  });

  it('records projects in its store, a missing store meaning none', async () => {
    const store = join(folder, 'recent-projects.json');
    expect(await readRecentProjects(store)).toEqual([]);
    await recordRecentProject(store, A);
    await recordRecentProject(store, B);
    expect(await readRecentProjects(store)).toEqual(local(B, A));
    expect(await readdir(folder)).toEqual(['recent-projects.json']);
  });

  it('keeps a store with a malformed entry aside and writes its valid entries back at once, so that they stay listed', async () => {
    const store = join(folder, 'recent-projects.json');
    await writeFile(store, JSON.stringify({ version: 1, paths: [A, 'relative/plan.tasklace', B] }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await readRecentProjects(store)).toEqual(local(A, B));
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(await readRecentProjects(store)).toEqual(local(A, B));
    expect(JSON.parse(await readFile(store, 'utf8'))).toEqual({
      version: 2,
      projects: local(A, B),
    });
  });

  it('logs a repaired list that cannot be written back, still giving its valid entries', async () => {
    const store = join(folder, 'recent-projects.json');
    await writeFile(store, JSON.stringify({ version: 1, paths: [A, 3] }));
    const refusal = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    writing.failure = refusal;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await readRecentProjects(store)).toEqual(local(A));
      expect(logged.mock.calls.slice(1)).toEqual([
        ['The repaired list of recent projects could not be written:', refusal],
      ]);
      expect(String(logged.mock.calls[0]?.[0])).toMatch(
        /^The list of recent projects was damaged and was kept as .*\.damaged-\d+\.$/,
      );
    } finally {
      logged.mockRestore();
      writing.failure = null;
    }
    expect(await readdir(folder)).toEqual([expect.stringMatching(/\.damaged-\d+$/)]);
  });

  it('keeps a damaged store aside before it is rewritten, logging where', async () => {
    const store = join(folder, 'recent-projects.json');
    await writeFile(store, '{broken');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await readRecentProjects(store)).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toMatch(
        /^The list of recent projects was damaged and was kept as .*recent-projects\.json\.damaged-\d+\.$/,
      );
    } finally {
      logged.mockRestore();
    }
    const aside = (await readdir(folder)).filter((name) => name.includes('.damaged-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(folder, aside[0] ?? ''), 'utf8')).toBe('{broken');
    await recordRecentProject(store, A);
    expect(await readRecentProjects(store)).toEqual(local(A));
  });
});

describe('the relay of a recent project', () => {
  it('reads a list of paths alone as projects shared through no relay', () => {
    expect(readRecentStore(JSON.stringify({ version: 1, paths: [A, B] }))).toEqual({
      entries: local(A, B),
      damaged: false,
    });
  });

  it('keeps the relay a project is shared through when it comes first again, unless another one or none is given', () => {
    const shared = [...local(A), { path: B, relay: RELAY }];
    expect([
      withRecentProject(shared, B),
      withRecentProject(shared, B, 'other.example'),
      withRecentProject(shared, B, null),
      withRecentProject(shared, A, RELAY),
    ]).toEqual([
      [{ path: B, relay: RELAY }, ...local(A)],
      [{ path: B, relay: 'other.example' }, ...local(A)],
      local(B, A),
      [
        { path: A, relay: RELAY },
        { path: B, relay: RELAY },
      ],
    ]);
  });

  it('notes or clears the relay of a listed project without moving it, and ignores a project not listed', () => {
    const listed = local(A, B);
    expect([
      withRelayOf(listed, B, RELAY),
      withRelayOf([{ path: A, relay: RELAY }], A, null),
      withRelayOf(listed, C, RELAY),
    ]).toEqual([[...local(A), { path: B, relay: RELAY }], local(A), listed]);
  });

  it.each([
    ['a relay that is not text', 7],
    ['an address with its scheme', 'wss://relay.example'],
    ['a host in capitals, not written as the application shows it', 'Relay.example'],
    ['a relay with a path', 'relay.example/v1'],
  ])('drops an entry with %s, telling that the store was damaged', (_case, relay) => {
    const text = JSON.stringify({ version: 2, projects: [{ path: A, relay }, ...local(B)] });
    expect(readRecentStore(text)).toEqual({ entries: local(B), damaged: true });
  });

  it('writes the relay of a recent project to its store only when that changes it', async () => {
    const store = join(folder, 'recent-projects.json');
    await recordRecentProject(store, A);
    await recordRecentProject(store, B);
    await noteRecentRelay(store, A, RELAY);
    expect(await readRecentProjects(store)).toEqual([...local(B), { path: A, relay: RELAY }]);
    writing.failure = new Error('No write was expected.');
    try {
      await noteRecentRelay(store, A, RELAY);
      await noteRecentRelay(store, C, RELAY);
    } finally {
      writing.failure = null;
    }
    await noteRecentRelay(store, A, null);
    expect(await readRecentProjects(store)).toEqual(local(B, A));
  });
});
