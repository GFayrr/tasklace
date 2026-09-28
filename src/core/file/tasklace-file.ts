import * as Y from 'yjs';
import { MAX_FILE_BYTES, MAX_UNCOMPRESSED_BYTES } from '../limits';
import { failure, success, type Result } from '../result';
import { openValidatedSession, type SharedSession } from '../shared/shared-session';
import { validateSharedDocument } from '../shared/shared-project';
import type { Project } from '../model/project';
import type { ValidationIssue } from '../validation/validation-issues';
import { crc32 } from './crc32';

const TASKLACE_SIGNATURE = Uint8Array.from('TSKL', (character) => character.charCodeAt(0));
const TASKLACE_FORMAT_VERSION = 1;
export const HEADER_BYTES = 16;

const VERSION_OFFSET = 4;
const FLAGS_OFFSET = 6;
const CHECKSUM_OFFSET = 8;
const DECLARED_SIZE_OFFSET = 12;
const NO_FLAGS = 0;
const LITTLE_ENDIAN = true;

export type DecompressionErrorCode = 'OUTPUT_TOO_LARGE' | 'INVALID_DATA';

export interface Compressor {
  readonly compress: (bytes: Uint8Array) => Uint8Array;
  readonly decompress: (
    bytes: Uint8Array,
    maxOutputBytes: number,
  ) => Result<Uint8Array, DecompressionErrorCode>;
}

export type FileError =
  | { readonly code: 'TOO_LARGE' }
  | { readonly code: 'TRUNCATED' }
  | { readonly code: 'NOT_A_TASKLACE_FILE' }
  | { readonly code: 'UNSUPPORTED_VERSION'; readonly version: number }
  | { readonly code: 'NEWER_FORMAT' }
  | { readonly code: 'CORRUPTED' }
  | { readonly code: 'DECOMPRESSION_BOMB' }
  | { readonly code: 'DECOMPRESSION_FAILED' }
  | { readonly code: 'INVALID_CONTENT' }
  | { readonly code: 'INVALID_PROJECT'; readonly issues: readonly ValidationIssue[] };

interface ValidatedFile {
  readonly document: Y.Doc;
  readonly project: Project;
}

/** Writes a shared document as a .tasklace file: a header holding the uncompressed size and a checksum of everything after it, then the compressed Yjs state. */
export function encodeTasklaceFile(document: Y.Doc, compressor: Compressor): Uint8Array {
  const state = Y.encodeStateAsUpdate(document);
  const payload = compressor.compress(state);
  const file = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(file.buffer);
  file.set(TASKLACE_SIGNATURE, 0);
  view.setUint16(VERSION_OFFSET, TASKLACE_FORMAT_VERSION, LITTLE_ENDIAN);
  view.setUint16(FLAGS_OFFSET, NO_FLAGS, LITTLE_ENDIAN);
  view.setUint32(DECLARED_SIZE_OFFSET, state.length, LITTLE_ENDIAN);
  file.set(payload, HEADER_BYTES);
  view.setUint32(CHECKSUM_OFFSET, crc32(file.subarray(DECLARED_SIZE_OFFSET)), LITTLE_ENDIAN);
  return file;
}

/** Reads an untrusted .tasklace file step by step and opens a shared session on it, loading nothing when any check fails. */
export function openTasklaceFile(
  file: Uint8Array,
  compressor: Compressor,
): Result<SharedSession, FileError> {
  const read = readValidatedFile(file, compressor);
  return read.ok ? success(openValidatedSession(read.value.document, read.value.project)) : read;
}

/** Reads an untrusted .tasklace file into a shared document holding a valid project, checking size, header, checksum, decompression, content and project in this order. */
export function readTasklaceFile(
  file: Uint8Array,
  compressor: Compressor,
): Result<Y.Doc, FileError> {
  const read = readValidatedFile(file, compressor);
  return read.ok ? success(read.value.document) : read;
}

/** Reads and checks an untrusted .tasklace file, returning its shared document with the project it validated. */
function readValidatedFile(
  file: Uint8Array,
  compressor: Compressor,
): Result<ValidatedFile, FileError> {
  const header = checkHeader(file);
  if (!header.ok) {
    return header;
  }
  const state = decompressPayload(file, header.value, compressor);
  if (!state.ok) {
    return state;
  }
  const document = decodeState(state.value);
  if (!document.ok) {
    return document;
  }
  const project = validateSharedDocument(document.value);
  return project.ok
    ? success({ document: document.value, project: project.value })
    : failure({ code: 'INVALID_PROJECT', issues: project.error });
}

/** Checks the size, signature, version, flags and checksum of a file and returns the uncompressed size it declares. */
function checkHeader(file: Uint8Array): Result<number, FileError> {
  if (file.length > MAX_FILE_BYTES) {
    return failure({ code: 'TOO_LARGE' });
  }
  if (file.length < HEADER_BYTES) {
    return failure({ code: 'TRUNCATED' });
  }
  if (!TASKLACE_SIGNATURE.every((byte, index) => file[index] === byte)) {
    return failure({ code: 'NOT_A_TASKLACE_FILE' });
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const version = view.getUint16(VERSION_OFFSET, LITTLE_ENDIAN);
  if (version !== TASKLACE_FORMAT_VERSION) {
    return failure({ code: 'UNSUPPORTED_VERSION', version });
  }
  if (view.getUint16(FLAGS_OFFSET, LITTLE_ENDIAN) !== NO_FLAGS) {
    return failure({ code: 'NEWER_FORMAT' });
  }
  if (
    view.getUint32(CHECKSUM_OFFSET, LITTLE_ENDIAN) !== crc32(file.subarray(DECLARED_SIZE_OFFSET))
  ) {
    return failure({ code: 'CORRUPTED' });
  }
  return success(view.getUint32(DECLARED_SIZE_OFFSET, LITTLE_ENDIAN));
}

/** Decompresses the content of a file without ever producing more than its declared size, itself capped, an empty state never being a document. */
function decompressPayload(
  file: Uint8Array,
  declaredSize: number,
  compressor: Compressor,
): Result<Uint8Array, FileError> {
  if (declaredSize > MAX_UNCOMPRESSED_BYTES) {
    return failure({ code: 'DECOMPRESSION_BOMB' });
  }
  if (declaredSize === 0) {
    return failure({ code: 'INVALID_CONTENT' });
  }
  const state = compressor.decompress(file.subarray(HEADER_BYTES), declaredSize);
  if (!state.ok) {
    return failure({
      code: state.error === 'OUTPUT_TOO_LARGE' ? 'DECOMPRESSION_BOMB' : 'DECOMPRESSION_FAILED',
    });
  }
  return state.value.length === declaredSize ? state : failure({ code: 'DECOMPRESSION_FAILED' });
}

/** Decodes a Yjs state into a new document, refusing a state that cannot be read or that depends on missing updates. */
function decodeState(state: Uint8Array): Result<Y.Doc, FileError> {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
  } catch {
    return failure({ code: 'INVALID_CONTENT' });
  }
  const complete = document.store.pendingStructs === null && document.store.pendingDs === null;
  return complete ? success(document) : failure({ code: 'INVALID_CONTENT' });
}
