import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { compareStrings } from '../compare-strings';
import { MAX_FILE_BYTES, MAX_TAGS, MAX_UNCOMPRESSED_BYTES } from '../limits';
import type { Project } from '../model/project';
import { failure, success } from '../result';
import {
  createSharedDocument,
  readSharedData,
  TAGS_ROOT,
  TASKS_ROOT,
} from '../shared/shared-document';
import { mergeSharedUpdate, readSharedProject } from '../shared/shared-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { at } from '../testing/civil-time';
import { hideListContent } from '../testing/hidden-list-content';
import { livedState, randomEditsArbitrary } from '../testing/lived-document';
import { projectArbitrary, richProjectArbitrary } from '../testing/project-arbitrary';
import {
  link,
  milestone,
  project,
  summary,
  workTask,
  TEST_DOCUMENT_ID,
} from '../testing/project-builder';
import { crc32 } from './crc32';
import {
  checkStateToSave,
  encodeTasklaceFile,
  encodeTasklaceState,
  HEADER_BYTES,
  openTasklaceFile,
  readTasklaceDocument,
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

const SIGNATURE_BYTES = 4;
const VIEW_PADDING_BYTES = 3;

const SAMPLE: Project = project(
  [
    summary('phase'),
    workTask('a', { parentId: 'phase', name: 'Écrire « le plan » 📝', tagId: 'design' }),
    workTask('b', { parentId: 'phase', hoursPerDay: 3 }),
    milestone('m', { progressPercent: 100 }),
  ],
  [link('a', 'b'), link('b', 'm')],
  {
    tags: [{ id: 'design', name: 'Design', color: '#336699', representsPersonOrTeam: true }],
    baseline: {
      takenAt: at(2026, 9, 27, 10),
      entries: [
        { taskId: 'a', start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 17), durationHours: 7 },
      ],
    },
  },
);

/** Writes a project as a .tasklace file with the stand-in compressor. */
function fileOf(input: Project): Uint8Array {
  return encodeTasklaceFile(createSharedDocument(input, TEST_DOCUMENT_ID), storingCompressor);
}

/** Decodes a Yjs state into a new document. */
function documentOf(state: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  return document;
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

/** Tells whether a file holds an ASCII text anywhere in its bytes. */
function containsText(file: Uint8Array, text: string): boolean {
  return Array.from(file, (byte) => String.fromCharCode(byte))
    .join('')
    .includes(text);
}

/** Returns the shared entry of a task, failing the test when it is missing. */
function taskEntry(document: Y.Doc, id: string): Y.Map<unknown> {
  const entry = document.getMap(TASKS_ROOT).get(id);
  if (!(entry instanceof Y.Map)) {
    throw new Error(`Missing task ${id}`);
  }
  return entry;
}

/** Writes the sample project as a file after changing its shared document. */
function tampered(change: (document: Y.Doc) => void): Uint8Array {
  const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
  change(document);
  return encodeTasklaceFile(document, storingCompressor);
}

/** Sorts the lists of a project by identifier. */
function sorted(input: Project): Project {
  /** Returns items ordered by identifier. */
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
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const file = encodeTasklaceFile(document, storingCompressor);
    const read = readTasklaceFile(file, storingCompressor);
    expect(read.ok && readSharedData(read.value)).toEqual(readSharedData(document));
    const opened = openTasklaceFile(file, storingCompressor);
    expect(opened.ok && opened.value.project()).toEqual(sorted(SAMPLE));
  });

  it('reads back every generated project unchanged', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(fc.oneof(projectArbitrary, richProjectArbitrary), ({ project: input }) => {
        const opened = openTasklaceFile(fileOf(input), storingCompressor);
        expect(opened.ok && opened.value.project()).toEqual(sorted(input));
      }),
    );
  });

  it('keeps the Yjs history, so that copies made before still merge after reading', () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    const read = readTasklaceFile(
      encodeTasklaceFile(document, storingCompressor),
      storingCompressor,
    );
    if (!read.ok) {
      throw new Error(read.error.code);
    }
    expect(Y.encodeStateVector(read.value)).toEqual(Y.encodeStateVector(document));
    peer.getMap('project').set('name', 'Renamed by a peer');
    const merged = mergeSharedUpdate(
      read.value,
      Y.encodeStateAsUpdate(peer, Y.encodeStateVector(read.value)),
    );
    expect(merged).toEqual(success([]));
    expect(readSharedData(read.value)).toEqual(readSharedData(peer));
  });

  it('leaves the text of deleted content out of the file', () => {
    const secret = 'SECRET-FORMER-NAME';
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    taskEntry(document, 'b').set('name', secret);
    expect(containsText(encodeTasklaceFile(document, storingCompressor), secret)).toBe(true);
    taskEntry(document, 'b').set('name', 'Public name');
    expect(containsText(encodeTasklaceFile(document, storingCompressor), secret)).toBe(false);
  });

  it('reads a file lying inside a larger buffer', () => {
    const file = fileOf(SAMPLE);
    const buffer = new Uint8Array(VIEW_PADDING_BYTES + file.length + VIEW_PADDING_BYTES);
    buffer.set(file, VIEW_PADDING_BYTES);
    const view = buffer.subarray(VIEW_PADDING_BYTES, VIEW_PADDING_BYTES + file.length);
    expect(readCode(view)).toBe('ok');
  });

  it('opens a file pointing at a missing tag without the tag, and reports it', () => {
    const lost = tampered((document) => {
      taskEntry(document, 'b').set('tagId', 'deleted');
    });
    const opened = openTasklaceFile(lost, storingCompressor);
    if (!opened.ok) {
      throw new Error(opened.error.code);
    }
    expect(opened.value.openingRepairs).toEqual([{ code: 'TAG_CLEARED', id: 'b' }]);
    expect(opened.value.project().tasks.find((task) => task.id === 'b')).toMatchObject({
      tagId: null,
    });
    const clean = openTasklaceFile(fileOf(SAMPLE), storingCompressor);
    expect(clean.ok && clean.value.openingRepairs).toEqual([]);
  });

  it('reads a file with the identifier of its document, refusing a file without one', () => {
    const source = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const read = readTasklaceDocument(
      encodeTasklaceFile(source, storingCompressor),
      storingCompressor,
    );
    expect(read.ok && read.value.documentId).toBe(TEST_DOCUMENT_ID);
    expect(read.ok && readSharedData(documentOf(read.value.state))).toEqual(readSharedData(source));
    const anonymous = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    anonymous.getMap('project').delete('documentId');
    expect(
      readTasklaceDocument(encodeTasklaceFile(anonymous, storingCompressor), storingCompressor),
    ).toEqual(
      failure({ code: 'INVALID_PROJECT', issues: [{ path: 'documentId', code: 'MISSING_FIELD' }] }),
    );
  });

  it(
    'gives a validated state holding exactly the document the file opens, as its encoding would, for documents that lived',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.oneof(projectArbitrary, richProjectArbitrary),
          randomEditsArbitrary,
          ({ project: generated }, edits) => {
            const file = encodeTasklaceFile(
              documentOf(livedState(generated, edits)),
              storingCompressor,
            );
            const read = readTasklaceDocument(file, storingCompressor);
            const opened = readTasklaceFile(file, storingCompressor);
            if (!read.ok || !opened.ok) {
              throw new Error('The file was refused.');
            }
            expect(Y.encodeStateAsUpdate(documentOf(read.value.state))).toEqual(
              Y.encodeStateAsUpdate(opened.value),
            );
          },
        ),
      );
    },
  );

  it('opens a session knowing the identifier of the document', () => {
    const opened = openTasklaceFile(fileOf(SAMPLE), storingCompressor);
    expect(opened.ok && opened.value.documentId).toBe(TEST_DOCUMENT_ID);
  });

  it('writes the same file from a document and from its encoded state', () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    expect(encodeTasklaceState(Y.encodeStateAsUpdate(document), storingCompressor)).toEqual(
      encodeTasklaceFile(document, storingCompressor),
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

  it('refuses a file with any byte of the signature changed', () => {
    for (let position = 0; position < SIGNATURE_BYTES; position += 1) {
      const copy = Uint8Array.from(file);
      copy[position] = 0;
      expect(readCode(copy)).toBe('NOT_A_TASKLACE_FILE');
    }
  });

  it('accepts the limits themselves and refuses an empty content', () => {
    expect(readCode(new Uint8Array(MAX_FILE_BYTES))).toBe('NOT_A_TASKLACE_FILE');
    expect(readCode(rewritten(file, { declaredSize: MAX_UNCOMPRESSED_BYTES }))).toBe(
      'DECOMPRESSION_FAILED',
    );
    expect(readCode(rewritten(file, { declaredSize: 0 }))).toBe('INVALID_CONTENT');
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
    const unreadable = readTasklaceFile(
      rewritten(file, { payload: garbage, declaredSize: garbage.length - 1 }),
      storingCompressor,
    );
    expect(unreadable.ok || unreadable.error.code).toBe('INVALID_CONTENT');
    expect(
      !unreadable.ok && 'reason' in unreadable.error && unreadable.error.reason,
    ).toBeInstanceOf(Error);
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    document.getMap('project').set('name', 'First');
    const between = Y.encodeStateVector(document);
    document.getMap('project').set('name', 'Second');
    const dependent = storedPayload(Y.encodeStateAsUpdate(document, between));
    expect(
      readCode(rewritten(file, { payload: dependent, declaredSize: dependent.length - 1 })),
    ).toBe('INVALID_CONTENT');
  });

  it('refuses a readable document holding an invalid project, without repairing it', () => {
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
    const hiddenList = tampered((document) => {
      hideListContent(document.getMap(TASKS_ROOT));
    });
    const withoutIdentifier = tampered((document) => {
      document.getMap('project').delete('documentId');
    });
    const malformedIdentifier = tampered((document) => {
      document.getMap('project').set('documentId', '../escape');
    });
    const unknownRoot = tampered((document) => {
      document.getMap('other').set('x', 1);
    });
    const plainEntry = tampered((document) => {
      document.getMap(TASKS_ROOT).set('z', { kind: 'task' });
    });
    const tooManyTags = tampered((document) => {
      for (let index = 0; index <= MAX_TAGS; index += 1) {
        const tag = new Y.Map<unknown>();
        document.getMap(TAGS_ROOT).set(`extra${String(index)}`, tag);
        tag.set('name', 'Extra');
        tag.set('color', '#336699');
        tag.set('representsPersonOrTeam', false);
      }
    });
    const invalidFiles = [
      cycle,
      unknownField,
      badHiddenField,
      hiddenList,
      withoutIdentifier,
      malformedIdentifier,
      unknownRoot,
      plainEntry,
      tooManyTags,
    ];
    for (const invalid of invalidFiles) {
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

describe('reading a file whose content was altered behind a valid checksum', () => {
  it(
    'never throws, refusing the file or giving a valid project',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
      const file = encodeTasklaceState(state, storingCompressor);
      fc.assert(
        fc.property(
          fc.nat({ max: state.length - 1 }),
          fc.integer({ min: 0, max: 255 }),
          (index, value) => {
            const altered = Uint8Array.from(state);
            altered[index] = value;
            const payload = storedPayload(altered);
            const read = readTasklaceFile(
              rewritten(file, { payload, declaredSize: altered.length }),
              storingCompressor,
            );
            if (read.ok) {
              expect(readSharedProject(read.value).ok).toBe(true);
            }
          },
        ),
      );
    },
  );
});

describe('checking a state before saving it', () => {
  const OTHER_DOCUMENT_ID = '00000000-0000-4000-8000-0000000000aa';

  it('accepts the complete state of a valid project of the expected document', () => {
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    expect(checkStateToSave(state, TEST_DOCUMENT_ID)).toEqual(success(null));
  });

  it('refuses the state of another document', () => {
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, OTHER_DOCUMENT_ID));
    expect(checkStateToSave(state, TEST_DOCUMENT_ID)).toEqual(failure({ code: 'WRONG_DOCUMENT' }));
  });

  it('refuses a state that cannot be decoded, or that misses an update it depends on', () => {
    expect(checkStateToSave(Uint8Array.from([255, 255, 255, 1]), TEST_DOCUMENT_ID)).toEqual(
      failure({ code: 'INVALID_STATE', issues: [] }),
    );
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const between = Y.encodeStateVector(document);
    document.getMap('project').set('name', 'Later');
    const dependent = Y.encodeStateAsUpdate(document, between);
    expect(checkStateToSave(dependent, TEST_DOCUMENT_ID)).toEqual(
      failure({ code: 'INVALID_STATE', issues: [] }),
    );
  });

  it('refuses a state holding hidden content, as when reading a file', () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    hideListContent(document.getMap(TASKS_ROOT));
    expect(checkStateToSave(Y.encodeStateAsUpdate(document), TEST_DOCUMENT_ID)).toEqual(
      failure({ code: 'INVALID_STATE', issues: [{ path: 'tasks', code: 'WRONG_TYPE' }] }),
    );
  });

  it('accepts the state of every generated project', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(fc.oneof(projectArbitrary, richProjectArbitrary), ({ project: input }) => {
        const state = Y.encodeStateAsUpdate(createSharedDocument(input, TEST_DOCUMENT_ID));
        expect(checkStateToSave(state, TEST_DOCUMENT_ID)).toEqual(success(null));
      }),
    );
  });

  it('refuses the state of an invalid project with its problems, without repairing it', () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    document.getMap('project').set('name', '');
    expect(checkStateToSave(Y.encodeStateAsUpdate(document), TEST_DOCUMENT_ID)).toEqual(
      failure({ code: 'INVALID_STATE', issues: [{ path: 'name', code: 'EMPTY_TEXT' }] }),
    );
  });
});
