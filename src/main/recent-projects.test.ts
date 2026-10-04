import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_PATH_LENGTH, MAX_RECENT_PROJECTS } from '../core/limits';
import {
  formatRecentProjects,
  readRecentProjects,
  readRecentStore,
  recordRecentProject,
  withRecentProject,
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

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-recent-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('recent projects', () => {
  it('puts the last opened project first, without duplicate, keeping only the limit', () => {
    expect(withRecentProject([A, B, C], B)).toEqual([B, A, C]);
    expect(withRecentProject([A, B, C], D)).toEqual([D, A, B]);
    expect(withRecentProject([A, B, C], D)).toHaveLength(MAX_RECENT_PROJECTS);
  });

  it('lists a project once whatever way its path is written, in the store or when recorded', () => {
    const unnormalized = A.replace('a.tasklace', join('.', 'x', '..', 'a.tasklace'));
    expect(withRecentProject([A, B], unnormalized)).toEqual([A, B]);
    expect(readRecentStore(formatRecentProjects([A, B, A, unnormalized, C]))).toEqual({
      paths: [A, B, C],
      damaged: false,
    });
  });

  it('reads back what it writes', () => {
    expect(readRecentStore(formatRecentProjects([A, B]))).toEqual({
      paths: [A, B],
      damaged: false,
    });
    expect(readRecentStore('')).toEqual({ paths: [], damaged: false });
  });

  it.each([
    'not json',
    '[]',
    'null',
    JSON.stringify({ version: 2, paths: [A] }),
    JSON.stringify({ version: 1, paths: 'a' }),
  ])('reads the damaged store %j as empty and damaged', (text) => {
    expect(readRecentStore(text)).toEqual({ paths: [], damaged: true });
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
    expect(readRecentStore(text)).toEqual({ paths: [A, B, C], damaged: true });
    const tooMany = formatRecentProjects([A, B, C, D]);
    expect(readRecentStore(tooMany)).toEqual({ paths: [A, B, C], damaged: false });
  });

  it('records projects in its store, a missing store meaning none', async () => {
    const store = join(folder, 'recent-projects.json');
    expect(await readRecentProjects(store)).toEqual([]);
    await recordRecentProject(store, A);
    await recordRecentProject(store, B);
    expect(await readRecentProjects(store)).toEqual([B, A]);
    expect(await readdir(folder)).toEqual(['recent-projects.json']);
  });

  it('keeps a store with a malformed entry aside and writes its valid entries back at once, so that they stay listed', async () => {
    const store = join(folder, 'recent-projects.json');
    await writeFile(store, JSON.stringify({ version: 1, paths: [A, 'relative/plan.tasklace', B] }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await readRecentProjects(store)).toEqual([A, B]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(await readRecentProjects(store)).toEqual([A, B]);
    expect(JSON.parse(await readFile(store, 'utf8'))).toEqual({ version: 1, paths: [A, B] });
  });

  it('logs a repaired list that cannot be written back, still giving its valid entries', async () => {
    const store = join(folder, 'recent-projects.json');
    await writeFile(store, JSON.stringify({ version: 1, paths: [A, 3] }));
    const refusal = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    writing.failure = refusal;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await readRecentProjects(store)).toEqual([A]);
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
    expect(await readRecentProjects(store)).toEqual([A]);
  });
});
