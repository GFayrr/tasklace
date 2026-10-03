import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CSV_FILE_BYTES, MAX_FILE_BYTES, MAX_JSON_FILE_BYTES } from '../core/limits';

const fileSystem = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  open: fileSystem.open,
}));

const { runFileTask } = await import('./file-tasks');

const OPEN_TASK = { kind: 'openProject', path: '/plan.tasklace' } as const;
const JSON_TASK = {
  kind: 'importJson',
  path: '/plan.json',
  documentId: '00000000-0000-4000-8000-000000000000',
  naming: { untitled: 'Untitled project', fromFile: 'plan' },
} as const;
const CSV_TASK = {
  kind: 'importCsv',
  path: '/plan.csv',
  documentId: '00000000-0000-4000-8000-000000000000',
  options: {
    format: {
      listSeparator: ';',
      dateOrder: 'dayMonthYear',
      dateSeparator: '/',
      twelveHourClock: false,
    },
    projectName: 'Plan',
    fallbackStart: 0,
  },
} as const;

/** Builds a file handle that claims a size, then delivers the bytes of a file of another size without storing them, and records its reads and whether it was closed. */
function handleOf(claimedSize: number, actualSize: number) {
  const handle = {
    closed: false,
    reads: 0,
    stat: () => Promise.resolve({ isFile: () => true, size: claimedSize }),
    read: (_buffer: Buffer, _offset: number, length: number, position: number) => {
      handle.reads += 1;
      return Promise.resolve({ bytesRead: Math.max(0, Math.min(length, actualSize - position)) });
    },
    close: () => {
      handle.closed = true;
      return Promise.resolve();
    },
  };
  return handle;
}

/** Builds a file handle that delivers a text once, then the end of the file. */
function handleWithContent(text: string) {
  const content = Buffer.from(text);
  return {
    stat: () => Promise.resolve({ isFile: () => true, size: content.length }),
    read: (buffer: Buffer, offset: number, length: number, position: number) =>
      Promise.resolve({ bytesRead: content.copy(buffer, offset, position, position + length) }),
    close: () => Promise.resolve(),
  };
}

afterEach(() => {
  fileSystem.open.mockReset();
});

describe('reading a file within the limit of its kind', () => {
  it.each([
    ['a project', OPEN_TASK, MAX_FILE_BYTES],
    ['a JSON import', JSON_TASK, MAX_JSON_FILE_BYTES],
    ['a CSV import', CSV_TASK, MAX_CSV_FILE_BYTES],
  ] as const)(
    'refuses %s larger than its limit without reading it, and closes it',
    async (_kind, task, limit) => {
      const handle = handleOf(limit + 1, limit + 1);
      fileSystem.open.mockResolvedValue(handle);
      expect(await runFileTask(task)).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
      expect(handle.reads).toBe(0);
      expect(handle.closed).toBe(true);
    },
  );

  it('reads a file exactly at the limit of its kind', async () => {
    const handle = handleWithContent('{"format"');
    fileSystem.open.mockResolvedValue({
      ...handle,
      stat: () => Promise.resolve({ isFile: () => true, size: MAX_JSON_FILE_BYTES }),
    });
    expect(await runFileTask(JSON_TASK)).toEqual({
      ok: false,
      error: { code: 'INVALID_IMPORT', issues: [{ path: '', code: 'INVALID_JSON' }] },
    });
  });
});

describe('reading a file that changes while it is read', () => {
  it('refuses a file that grows past its limit after its size was checked, keeping nothing of it, and closes it', async () => {
    const handle = handleOf(10, MAX_FILE_BYTES + 1);
    fileSystem.open.mockResolvedValue({
      ...handle,
      read: () => Promise.resolve({ bytesRead: MAX_FILE_BYTES + 1 }),
    });
    expect(await runFileTask(OPEN_TASK)).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(handle.closed).toBe(true);
  });

  it('reads only what is left of a file that shrinks after its size was checked', async () => {
    const handle = handleWithContent('TSKL');
    fileSystem.open.mockResolvedValue({
      ...handle,
      stat: () => Promise.resolve({ isFile: () => true, size: 1_000 }),
    });
    expect(await runFileTask(OPEN_TASK)).toEqual({ ok: false, error: { code: 'TRUNCATED' } });
  });

  it('lets a failure that is not an error of the system through', async () => {
    fileSystem.open.mockRejectedValue('broken');
    await expect(runFileTask(OPEN_TASK)).rejects.toBe('broken');
    fileSystem.open.mockRejectedValue(new Error('program fault'));
    await expect(runFileTask(OPEN_TASK)).rejects.toThrow('program fault');
  });

  it('keeps the result of a read whose file cannot be closed, logging the closing failure', async () => {
    const handle = {
      ...handleWithContent('not a project'),
      close: () => Promise.reject(new Error('close failed')),
    };
    fileSystem.open.mockResolvedValue(handle);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runFileTask(OPEN_TASK)).toEqual({
        ok: false,
        error: { code: 'TRUNCATED' },
      });
      expect(logged).toHaveBeenCalledWith(
        'The file read could not be closed:',
        new Error('close failed'),
      );
    } finally {
      logged.mockRestore();
    }
  });
});

/** Imports a text while the decoder fails with a given error. */
async function importWhileDecoderThrows(error: Error) {
  fileSystem.open.mockResolvedValue(handleWithContent('{}'));
  const decode = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(() => {
    throw error;
  });
  try {
    return await runFileTask(JSON_TASK);
  } finally {
    decode.mockRestore();
  }
}

describe('decoding an imported text', () => {
  it('refuses as too large a text longer than the engine can hold', async () => {
    expect(await importWhileDecoderThrows(new RangeError('Invalid string length'))).toEqual({
      ok: false,
      error: { code: 'TOO_LARGE' },
    });
  });

  it('lets an unexpected failure of the decoder through', async () => {
    await expect(importWhileDecoderThrows(new Error('decoder broken'))).rejects.toThrow(
      'decoder broken',
    );
  });
});
