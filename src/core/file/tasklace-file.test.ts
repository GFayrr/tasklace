import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { compareStrings } from '../compare-strings';
import { MAX_FILE_BYTES, MAX_UNCOMPRESSED_BYTES } from '../limits';
import type { Project } from '../model/project';
import { failure, success } from '../result';
import { createSharedDocument, readSharedData, TASKS_ROOT } from '../shared/shared-document';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { projectArbitrary } from '../testing/project-arbitrary';
import { link, milestone, project, summary, workTask } from '../testing/project-builder';
import { crc32 } from './crc32';
import {
  encodeTasklaceFile,
  HEADER_BYTES,
  openTasklaceFile,
  readTasklaceFile,
  type Compressor,
} from './tasklace-file';

const STORED_MARKER = 1;
const CHECKSUM_OFFSET = 8;
const DECLARED_SIZE_OFFSET = 12;
const HEADER_FIELDS = { version: 4, flags: 6 } as const;

/** A stand-in compressor that stores bytes behind a marker, refusing a wrong marker and output beyond the cap. */
const storingCompressor: Compressor = {
  compress: (bytes) => Uint8Array.from([STORED_MARKER, ...bytes]),
  decompress: (bytes, maxOutputBytes) => {
    if (bytes[0] !== STORED_MARKER) {
      return failure('INVALID_DATA');
    }
    const output = bytes.subarray(1);
    return output.length > maxOutputBytes
      ? failure('OUTPUT_TOO_LARGE')
      : success(Uint8Array.from(output));
  },
};

const SAMPLE: Project = project(
  [
    summary('phase'),
    workTask('a', { parentId: 'phase', name: 'Écrire « le plan » 📝' }),
    workTask('b', { parentId: 'phase', hoursPerDay: 3 }),
    milestone('m', { progressPercent: 100 }),
  ],
  [link('a', 'b'), link('b', 'm')],
);

/** Writes a project as a .tasklace file with the stand-in compressor. */
function fileOf(input: Project): Uint8Array {
  return encodeTasklaceFile(createSharedDocument(input), storingCompressor);
}

/** Returns a copy of a file with some header fields or its payload replaced, and a recomputed checksum, as an attacker would. */
function rewritten(
  file: Uint8Array,
  changes: {
    readonly version?: number;
    readonly flags?: number;
    readonly declaredSize?: number;
    readonly payload?: Uint8Array;
  },
): Uint8Array {
  const payload = changes.payload ?? file.subarray(HEADER_BYTES);
  const copy = new Uint8Array(HEADER_BYTES + payload.length);
  copy.set(file.subarray(0, HEADER_BYTES), 0);
  copy.set(payload, HEADER_BYTES);
  const view = new DataView(copy.buffer);
  if (changes.version !== undefined) {
    view.setUint16(HEADER_FIELDS.version, changes.version, true);
  }
  if (changes.flags !== undefined) {
    view.setUint16(HEADER_FIELDS.flags, changes.flags, true);
  }
  if (changes.declaredSize !== undefined) {
    view.setUint32(DECLARED_SIZE_OFFSET, changes.declaredSize, true);
  }
  view.setUint32(CHECKSUM_OFFSET, crc32(copy.subarray(DECLARED_SIZE_OFFSET)), true);
  return copy;
}

/** Returns the error code of reading a file, or 'ok' when it is accepted. */
function readCode(file: Uint8Array): string {
  const read = readTasklaceFile(file, storingCompressor);
  return read.ok ? 'ok' : read.error.code;
}

/** Stores a raw Yjs state behind the stand-in marker as the payload of a file. */
function storedPayload(state: Uint8Array): Uint8Array {
  return storingCompressor.compress(state);
}

/** Sorts the lists of a project by identifier. */
function sorted(input: Project): Project {
  const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...input,
    tasks: byId(input.tasks),
    dependencies: byId(input.dependencies),
    tags: byId(input.tags),
  };
}

describe('tasklace file', () => {
  it('reads back what it wrote, as a shared document and as a session', () => {
    const document = createSharedDocument(SAMPLE);
    const file = encodeTasklaceFile(document, storingCompressor);
    const read = readTasklaceFile(file, storingCompressor);
    expect(read.ok && readSharedData(read.value)).toEqual(readSharedData(document));
    const opened = openTasklaceFile(file, storingCompressor);
    expect(opened.ok && opened.value.project()).toEqual(sorted(SAMPLE));
  });

  it('reads back every generated project unchanged', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(projectArbitrary, ({ project: input }) => {
        const opened = openTasklaceFile(fileOf(input), storingCompressor);
        expect(opened.ok && opened.value.project()).toEqual(sorted(input));
      }),
    );
  });

  it('starts with the signature, the version and no flags', () => {
    const file = fileOf(SAMPLE);
    expect([...file.subarray(0, 8)]).toEqual([0x54, 0x53, 0x4b, 0x4c, 1, 0, 0, 0]);
  });
});

describe('reading an untrusted tasklace file', () => {
  const file = fileOf(SAMPLE);

  it('refuses a file larger than the limit before looking at it', () => {
    expect(readCode(new Uint8Array(MAX_FILE_BYTES + 1))).toBe('TOO_LARGE');
  });

  it('refuses a file shorter than its header', () => {
    for (let length = 0; length < HEADER_BYTES; length += 1) {
      expect(readCode(file.subarray(0, length))).toBe('TRUNCATED');
    }
  });

  it('refuses a file without the signature', () => {
    const copy = Uint8Array.from(file);
    copy[0] = 0;
    expect(readCode(copy)).toBe('NOT_A_TASKLACE_FILE');
  });

  it.each([0, 2, 65_535])('refuses the format version %i and reports it', (version) => {
    const read = readTasklaceFile(rewritten(file, { version }), storingCompressor);
    expect(read.ok || read.error).toEqual({ code: 'UNSUPPORTED_VERSION', version });
  });

  it.each([1, 0x8000])('refuses a file with the flags %i as a newer format', (flags) => {
    expect(readCode(rewritten(file, { flags }))).toBe('NEWER_FORMAT');
  });

  it('detects any altered byte after the flags, and any truncation, with the checksum', () => {
    for (let position = CHECKSUM_OFFSET; position < file.length; position += 1) {
      const copy = Uint8Array.from(file);
      copy[position] = (copy[position] ?? 0) ^ 0xff;
      expect(readCode(copy)).toBe('CORRUPTED');
    }
    for (let length = HEADER_BYTES; length < file.length; length += 1) {
      expect(readCode(file.subarray(0, length))).toBe('CORRUPTED');
    }
  });

  it('refuses a declared size beyond the limit before decompressing', () => {
    expect(readCode(rewritten(file, { declaredSize: MAX_UNCOMPRESSED_BYTES + 1 }))).toBe(
      'DECOMPRESSION_BOMB',
    );
  });

  it('stops decompressing at the declared size', () => {
    const declared = file.length - HEADER_BYTES - 2;
    expect(readCode(rewritten(file, { declaredSize: declared }))).toBe('DECOMPRESSION_BOMB');
  });

  it('refuses content that is shorter than declared or cannot be decompressed', () => {
    expect(readCode(rewritten(file, { declaredSize: file.length }))).toBe('DECOMPRESSION_FAILED');
    const payload = Uint8Array.from(file.subarray(HEADER_BYTES));
    payload[0] = 0;
    expect(readCode(rewritten(file, { payload }))).toBe('DECOMPRESSION_FAILED');
  });

  it('refuses a Yjs state that cannot be decoded or is incomplete', () => {
    const garbage = storedPayload(Uint8Array.from([255, 255, 255, 255, 1, 2, 3]));
    expect(readCode(rewritten(file, { payload: garbage, declaredSize: garbage.length - 1 }))).toBe(
      'INVALID_CONTENT',
    );
    const document = createSharedDocument(SAMPLE);
    const before = Y.encodeStateVector(document);
    document.getMap('project').set('name', 'First');
    const between = Y.encodeStateVector(document);
    document.getMap('project').set('name', 'Second');
    const dependent = storedPayload(Y.encodeStateAsUpdate(document, between));
    expect(before.length).toBeGreaterThan(0);
    expect(
      readCode(rewritten(file, { payload: dependent, declaredSize: dependent.length - 1 })),
    ).toBe('INVALID_CONTENT');
  });

  it('refuses a readable document holding an invalid project, without repairing it', () => {
    const tampered = (change: (document: Y.Doc) => void): Uint8Array => {
      const document = createSharedDocument(SAMPLE);
      change(document);
      return encodeTasklaceFile(document, storingCompressor);
    };
    const cycle = tampered((document) => {
      const entry = new Y.Map<unknown>();
      document.getMap('dependencies').set('m-a', entry);
      Object.entries(link('m', 'a'))
        .filter(([key]) => key !== 'id')
        .forEach(([key, value]) => {
          entry.set(key, value);
        });
    });
    const unknownField = tampered((document) => {
      const entry = document.getMap(TASKS_ROOT).get('a');
      if (entry instanceof Y.Map) {
        entry.set('junk', 1);
      }
    });
    const badHiddenField = tampered((document) => {
      const entry = document.getMap(TASKS_ROOT).get('phase');
      if (entry instanceof Y.Map) {
        entry.set('segments', 'garbage');
      }
    });
    for (const invalid of [cycle, unknownField, badHiddenField]) {
      const read = readTasklaceFile(invalid, storingCompressor);
      expect(read.ok || read.error.code).toBe('INVALID_PROJECT');
      expect(openTasklaceFile(invalid, storingCompressor).ok).toBe(false);
    }
  });

  it(
    'never throws and never accepts random bytes, with or without a valid header',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 400 }), fc.boolean(), (bytes, withHeader) => {
          const candidate = withHeader
            ? rewritten(file, { payload: bytes, declaredSize: Math.max(bytes.length - 1, 0) })
            : bytes;
          expect(readTasklaceFile(candidate, storingCompressor).ok).toBe(false);
        }),
      );
    },
  );
});
