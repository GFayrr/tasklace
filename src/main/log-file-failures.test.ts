import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sizeFailure = vi.hoisted((): { error: Error | null } => ({ error: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const stat = (path: string): ReturnType<typeof original.stat> =>
    sizeFailure.error === null ? original.stat(path) : Promise.reject(sizeFailure.error);
  return { ...original, stat };
});

const { createLogFile } = await import('./log-file');

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-log-'));
});

afterEach(async () => {
  sizeFailure.error = null;
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
