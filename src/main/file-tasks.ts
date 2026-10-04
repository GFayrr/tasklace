import { open, type FileHandle } from 'node:fs/promises';
import * as Y from 'yjs';
import type { CsvWarning } from '../core/exchange/csv/csv-rows';
import { importProjectCsv, type CsvImportOptions } from '../core/exchange/csv/project-csv-import';
import { importProjectJson } from '../core/exchange/project-json';
import {
  MAX_CSV_FILE_BYTES,
  MAX_FILE_BYTES,
  MAX_JSON_FILE_BYTES,
  UNITS_PER_MEBI,
} from '../core/limits';
import {
  checkStateToSave,
  encodeTasklaceState,
  readTasklaceDocument,
} from '../core/file/tasklace-file';
import type { Project } from '../core/model/project';
import { failure, success, type Result } from '../core/result';
import { createSharedDocument, type DocumentId } from '../core/shared/shared-document';
import type { FileFailure } from '../preload/bridge-contract';
import { saveLocalCopy } from './local-copies';
import { isSystemError } from './stored-files';
import { writeFileSafely } from './safe-write';
import { zlibCompressor } from './zlib-compressor';

export type FileTask =
  | { readonly kind: 'openProject'; readonly path: string }
  | {
      readonly kind: 'importJson';
      readonly path: string;
      readonly documentId: DocumentId;
      readonly naming: ImportNaming;
    }
  | {
      readonly kind: 'importCsv';
      readonly path: string;
      readonly documentId: DocumentId;
      readonly options: CsvImportOptions;
    }
  | {
      readonly kind: 'saveProject';
      readonly path: string | null;
      readonly state: Uint8Array;
      readonly documentId: DocumentId;
      readonly localCopyFolder: string;
      readonly savedAt: number;
    };

export interface ImportNaming {
  readonly untitled: string;
  readonly fromFile: string;
}

export interface LoadedProject {
  readonly kind: 'loaded';
  readonly state: Uint8Array;
  readonly documentId: DocumentId;
  readonly warnings: readonly CsvWarning[];
}

export interface SavedFiles {
  readonly kind: 'saved';
  readonly localCopySaved: boolean;
}

export type FileTaskResult = Result<LoadedProject | SavedFiles, FileFailure>;
export type TaskOutcome<T extends FileTask> = T extends { readonly kind: 'saveProject' }
  ? SavedFiles
  : LoadedProject;
export type ResultOfTask<T extends FileTask> = Result<TaskOutcome<T>, FileFailure>;

/** Tells whether a value has the shape of a result of a task: a failure, or a success of the kind the task gives, a saved file for a save and a loaded project otherwise. */
export function isResultOf<T extends FileTask>(task: T, value: unknown): value is ResultOfTask<T> {
  const ok: unknown = Reflect.get(Object(value), 'ok');
  if (ok !== true) {
    return ok === false;
  }
  const kind: unknown = Reflect.get(Object(Reflect.get(Object(value), 'value')), 'kind');
  return kind === (task.kind === 'saveProject' ? 'saved' : 'loaded');
}

const READ_CHUNK_BYTES = 16 * UNITS_PER_MEBI;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Runs one file task: reading and checking a project file or an import, or writing a project and its local copy. */
export async function runFileTask(task: FileTask): Promise<FileTaskResult> {
  switch (task.kind) {
    case 'openProject':
      return openProject(task.path);
    case 'importJson':
      return importText(task.path, MAX_JSON_FILE_BYTES, (text) =>
        importJsonText(text, task.documentId, task.naming),
      );
    case 'importCsv':
      return importText(task.path, MAX_CSV_FILE_BYTES, (text) =>
        importCsvText(text, task.documentId, task.options),
      );
    case 'saveProject':
      return saveProject(task);
  }
}

/** Reads a .tasklace file and checks it completely, giving back its Yjs state and document identifier. */
async function openProject(path: string): Promise<FileTaskResult> {
  const bytes = await readBytes(path, MAX_FILE_BYTES);
  if (!bytes.ok) {
    return bytes;
  }
  const read = readTasklaceDocument(bytes.value, zlibCompressor);
  if (!read.ok) {
    return failure(read.error);
  }
  const { document, documentId } = read.value;
  return success({
    kind: 'loaded',
    state: Y.encodeStateAsUpdate(document),
    documentId,
    warnings: [],
  });
}

/** Reads a text file strictly as UTF-8, keeping its byte order mark for the importer, and imports it. */
async function importText(
  path: string,
  limit: number,
  importer: (text: string) => FileTaskResult,
): Promise<FileTaskResult> {
  const bytes = await readBytes(path, limit);
  if (!bytes.ok) {
    return bytes;
  }
  const text = decodeUtf8(bytes.value);
  return text.ok ? importer(text.value) : text;
}

/** Imports a JSON project into a new shared document, a project still bearing the untitled name taking the name of its file. */
function importJsonText(
  text: string,
  documentId: DocumentId,
  naming: ImportNaming,
): FileTaskResult {
  const project = importProjectJson(text);
  if (!project.ok) {
    return failure({ code: 'INVALID_IMPORT', issues: project.error });
  }
  const untitled = project.value.name === naming.untitled;
  const named = untitled ? { ...project.value, name: naming.fromFile } : project.value;
  return success(loaded(named, documentId, []));
}

/** Imports a CSV task table into a new shared document, keeping its warnings. */
function importCsvText(
  text: string,
  documentId: DocumentId,
  options: CsvImportOptions,
): FileTaskResult {
  const imported = importProjectCsv(text, options);
  return imported.ok
    ? success(loaded(imported.value.project, documentId, imported.value.warnings))
    : failure({ code: 'INVALID_IMPORT', issues: imported.error });
}

/** Builds the Yjs state of a new shared document holding an imported project. */
function loaded(
  project: Project,
  documentId: DocumentId,
  warnings: LoadedProject['warnings'],
): LoadedProject {
  const state = Y.encodeStateAsUpdate(createSharedDocument(project, documentId));
  return { kind: 'loaded', state, documentId, warnings };
}

/** Checks the state to save, then writes the project file safely when it has one and its local copy in every case, so that a failed file still leaves a local copy: the save fails when the file, or for a project without file its local copy, could not be written, and otherwise tells whether the local copy was written. */
async function saveProject(
  task: Extract<FileTask, { kind: 'saveProject' }>,
): Promise<FileTaskResult> {
  const checked = checkStateToSave(task.state, task.documentId);
  if (!checked.ok) {
    return failure(checked.error);
  }
  const file = encodeTasklaceState(task.state, zlibCompressor);
  const { path } = task;
  const fileWritten =
    path === null || (await attemptWrite('The project file', () => writeFileSafely(path, file)));
  const localCopySaved = await attemptWrite('The local copy', () =>
    saveLocalCopy(task.localCopyFolder, task.documentId, file, path, new Date(task.savedAt)),
  );
  if (!fileWritten || (path === null && !localCopySaved)) {
    return failure({ code: 'WRITE_FAILED' });
  }
  return success({ kind: 'saved', localCopySaved });
}

/** Runs a write and tells whether it succeeded, logging the whole error that stopped it. */
async function attemptWrite(what: string, write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`${what} could not be written:`, error);
      return false;
    }
    throw error;
  }
}

/** Reads the bytes of a regular file through a single handle, checking its size on that same handle and reading at most one byte past the limit, so that a file growing or replaced meanwhile, or a device, can never be read without bound. */
async function readBytes(path: string, limit: number): Promise<Result<Uint8Array, FileFailure>> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    const details = await handle.stat();
    if (!details.isFile()) {
      return failure({ code: 'READ_FAILED' });
    }
    if (details.size > limit) {
      return failure({ code: 'TOO_LARGE' });
    }
    return await readAtMost(handle, limit);
  } catch (error) {
    if (isSystemError(error)) {
      console.error('The file could not be read:', error);
      return failure({ code: 'READ_FAILED' });
    }
    throw error;
  } finally {
    await handle?.close().catch((error: unknown) => {
      console.error('The file read could not be closed:', error);
    });
  }
}

/** Reads a file handle up to one byte past a limit, refusing a file that turns out larger than the limit. */
async function readAtMost(
  handle: FileHandle,
  limit: number,
): Promise<Result<Uint8Array, FileFailure>> {
  const buffer = Buffer.alloc(Math.min(limit + 1, READ_CHUNK_BYTES));
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) {
      return success(Buffer.concat(chunks, total));
    }
    total += bytesRead;
    if (total > limit) {
      return failure({ code: 'TOO_LARGE' });
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
}

/** Decodes bytes as strict UTF-8, refusing bytes that are not UTF-8 and a text longer than the engine can hold. */
function decodeUtf8(bytes: Uint8Array): Result<string, FileFailure> {
  try {
    return success(UTF8_DECODER.decode(bytes));
  } catch (error) {
    if (error instanceof TypeError) {
      return failure({ code: 'INVALID_ENCODING' });
    }
    if (error instanceof RangeError) {
      return failure({ code: 'TOO_LARGE' });
    }
    throw error;
  }
}
