import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSafely } from './safe-write';
import { createSerialQueue } from './serial-queue';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-safe-write-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('writeFileSafely', () => {
  it('writes a new file and replaces an existing one, leaving no temporary file', async () => {
    const path = join(folder, 'project.tasklace');
    await writeFileSafely(path, Uint8Array.from([1, 2, 3]));
    await writeFileSafely(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
    expect(await readdir(folder)).toEqual(['project.tasklace']);
  });

  it('fails without touching the target nor leaving a temporary file when the target cannot be replaced', async () => {
    const target = join(folder, 'taken');
    await mkdir(target);
    await writeFile(join(target, 'inside'), 'kept');
    await expect(writeFileSafely(target, 'new')).rejects.toHaveProperty('syscall', 'rename');
    expect(await readdir(folder)).toEqual(['taken']);
    expect(await readFile(join(target, 'inside'), 'utf8')).toBe('kept');
  });

  it('fails when the folder does not exist', async () => {
    await expect(writeFileSafely(join(folder, 'missing', 'file'), 'x')).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
  });
});

describe('createSerialQueue', () => {
  it('runs tasks one after the other in order, even after a failure', async () => {
    const runInOrder = createSerialQueue();
    const events: string[] = [];
    const slow = runInOrder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('slow');
      throw new Error('first fails');
    });
    const fast = runInOrder(() => {
      events.push('fast');
      return Promise.resolve('done');
    });
    await expect(slow).rejects.toThrow('first fails');
    await expect(fast).resolves.toBe('done');
    expect(events).toEqual(['slow', 'fast']);
  });
});
