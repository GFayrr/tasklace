import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_PATH_LENGTH, MAX_RECENT_PROJECTS } from '../core/limits';
import {
  formatRecentProjects,
  parseRecentProjects,
  readRecentProjects,
  recordRecentProject,
  withRecentProject,
} from './recent-projects';

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

  it('reads back what it writes', () => {
    expect(parseRecentProjects(formatRecentProjects([A, B]))).toEqual([A, B]);
  });

  it.each([
    '',
    'not json',
    '[]',
    'null',
    JSON.stringify({ version: 2, paths: [A] }),
    JSON.stringify({ version: 1, paths: 'a' }),
  ])('treats the damaged store %j as empty', (text) => {
    expect(parseRecentProjects(text)).toEqual([]);
  });

  it('keeps only well-formed absolute paths, within the limit', () => {
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
    expect(parseRecentProjects(text)).toEqual([A, B, C]);
  });

  it('records projects in its store, a missing store meaning none', async () => {
    const store = join(folder, 'recent-projects.json');
    expect(await readRecentProjects(store)).toEqual([]);
    await recordRecentProject(store, A);
    await recordRecentProject(store, B);
    expect(await readRecentProjects(store)).toEqual([B, A]);
    await writeFile(store, '{broken');
    expect(await readRecentProjects(store)).toEqual([]);
  });
});
