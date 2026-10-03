import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { importProjectCsv, type CsvImportOptions } from '../core/exchange/csv/project-csv-import';
import { importProjectJson } from '../core/exchange/project-json';
import { encodeTasklaceState, readTasklaceFile } from '../core/file/tasklace-file';
import type { Project } from '../core/model/project';
import { failure, success, type Result } from '../core/result';
import {
  createSharedDocument,
  readDocumentId,
  type DocumentId,
} from '../core/shared/shared-document';
import type { FileFailure } from '../preload/bridge-contract';
import { saveLocalCopy } from './local-copies';
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
  readonly state: Uint8Array;
  readonly documentId: DocumentId;
  readonly warnings: readonly { readonly path: string; readonly code: string }[];
}

export type FileTaskResult = Result<LoadedProject | null, FileFailure>;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Runs one file task: reading and checking a project file or an import, or writing a project and its local copy. */
export async function runFileTask(task: FileTask): Promise<FileTaskResult> {
  switch (task.kind) {
    case 'openProject':
      return openProject(task.path);
    case 'importJson':
      return importText(task.path, (text) => importJsonText(text, task.documentId, task.naming));
    case 'importCsv':
      return importText(task.path, (text) => importCsvText(text, task.documentId, task.options));
    case 'saveProject':
      return saveProject(task);
  }
}

/** Reads a .tasklace file and checks it completely, giving back its Yjs state and document identifier. */
async function openProject(path: string): Promise<FileTaskResult> {
  const bytes = await readBytes(path);
  if (!bytes.ok) {
    return bytes;
  }
  const read = readTasklaceFile(bytes.value, zlibCompressor);
  if (!read.ok) {
    return failure(read.error);
  }
  const documentId = readDocumentId(read.value);
  return documentId === null
    ? failure({ code: 'INVALID_CONTENT' })
    : success({ state: Y.encodeStateAsUpdate(read.value), documentId, warnings: [] });
}

/** Reads a text file strictly as UTF-8, keeping its byte order mark for the importer, and imports it. */
async function importText(
  path: string,
  importer: (text: string) => FileTaskResult,
): Promise<FileTaskResult> {
  const bytes = await readBytes(path);
  if (!bytes.ok) {
    return bytes;
  }
  const text = decodeUtf8(bytes.value);
  return text === null ? failure({ code: 'INVALID_ENCODING' }) : importer(text);
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
  return { state, documentId, warnings };
}

/** Writes a project file safely when it has one, then its local copy, which alone keeps a project not saved yet, reporting a failure to write either. */
async function saveProject(
  task: Extract<FileTask, { kind: 'saveProject' }>,
): Promise<FileTaskResult> {
  const file = encodeTasklaceState(task.state, zlibCompressor);
  try {
    if (task.path !== null) {
      await writeFileSafely(task.path, file);
    }
    await saveLocalCopy(
      task.localCopyFolder,
      task.documentId,
      file,
      task.path,
      new Date(task.savedAt),
    );
    return success(null);
  } catch (error) {
    if (error instanceof Error) {
      return failure({ code: 'WRITE_FAILED' });
    }
    throw error;
  }
}

/** Reads the bytes of a file, reporting a file that cannot be read. */
async function readBytes(path: string): Promise<Result<Uint8Array, FileFailure>> {
  try {
    return success(await readFile(path));
  } catch (error) {
    if (error instanceof Error) {
      return failure({ code: 'READ_FAILED' });
    }
    throw error;
  }
}

/** Decodes bytes as strict UTF-8, or returns null for bytes that are not UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}
