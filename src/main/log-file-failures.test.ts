import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sizeFailure = vi.hoisted((): { error: Error | null } => ({ error: null }));
const renameFailure = vi.hoisted((): { error: Error | null } => ({ error: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const stat = (path: string): ReturnType<typeof original.stat> =>
    sizeFailure.error === null ? original.stat(path) : Promise.reject(sizeFailure.error);
  const rename = (from: string, to: string): Promise<void> =>
    renameFailure.error === null ? original.rename(from, to) : Promise.reject(renameFailure.error);
  return { ...original, stat, rename };
});

const { createLogFile } = await import('./log-file');
const { MAX_LOG_BYTES } = await import('../core/limits');

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-log-'));
});

afterEach(async () => {
  sizeFailure.error = null;
  renameFailure.error = null;
  await rm(folder, { recursive: true, force: true });
});

describe('a log whose size cannot be read', () => {
  it('reports the failure instead of writing past its limit', async () => {
    const refusal = Object.assign(new Error('access denied'), { code: 'EACCES' });
    sizeFailure.error = refusal;
    const failures: unknown[] = [];
    const log = createLogFile(
      folder,
      () => new Date(0),
      (error) => failures.push(error),
    );
    log.write('error', 'lost');
    await log.written();
    expect(failures).toEqual([refusal]);
  });
});

describe('a log that cannot be set aside', () => {
  it('reports it once and keeps writing in the same file until the next attempt', async () => {
    const path = join(folder, 'tasklace.log');
    await writeFile(path, 'a'.repeat(MAX_LOG_BYTES - 10));
    const refusal = Object.assign(new Error('file locked'), { code: 'EBUSY' });
    renameFailure.error = refusal;
    const failures: unknown[] = [];
    const log = createLogFile(
      folder,
      () => new Date(0),
      (error) => failures.push(error),
    );
    log.write('error', 'first');
    log.write('error', 'second');
    await log.written();
    expect(failures).toEqual([refusal]);
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('ERROR first\n1970-01-01T00:00:00.000Z ERROR second\n')).toBe(true);
  });
});
