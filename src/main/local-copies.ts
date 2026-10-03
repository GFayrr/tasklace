import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDocumentId, type DocumentId } from '../core/shared/shared-document';
import { isStoredPath, parseStoredJson, readStoredText, setDamagedFileAside } from './stored-files';
import { writeFileSafely } from './safe-write';
import { createSerialQueue } from './serial-queue';

export interface LocalCopyEntry {
  readonly path: string | null;
  readonly savedAt: string;
}

export type LocalCopyIndex = Readonly<Record<DocumentId, LocalCopyEntry>>;

const INDEX_FILE = 'index.json';
const COPY_EXTENSION = '.tasklace';
const INDEX_VERSION = 1;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const runInOrder = createSerialQueue();

/** Returns where the local copy of a document is kept, only for a valid identifier so that no identifier can point outside the folder. */
export function localCopyPath(folder: string, documentId: DocumentId): string | null {
  return isDocumentId(documentId) ? join(folder, `${documentId}${COPY_EXTENSION}`) : null;
}

export interface IndexReading {
  readonly index: LocalCopyIndex;
  readonly damaged: boolean;
}

/** Parses the untrusted text of the local copy index, keeping only well-formed entries and telling whether anything had to be dropped, an empty text, as read for a missing index, counting as undamaged. */
export function readIndexText(text: string): IndexReading {
  if (text === '') {
    return { index: {}, damaged: false };
  }
  const data = parseStoredJson(text);
  const copies: unknown = Reflect.get(Object(data), 'copies');
  if (
    Reflect.get(Object(data), 'version') !== INDEX_VERSION ||
    typeof copies !== 'object' ||
    copies === null
  ) {
    return { index: {}, damaged: true };
  }
  const all = Object.entries(copies);
  const entries = all.filter(
    (entry): entry is [DocumentId, LocalCopyEntry] => isDocumentId(entry[0]) && isEntry(entry[1]),
  );
  const index = Object.fromEntries(
    entries.map(([id, entry]) => [id, { path: entry.path, savedAt: entry.savedAt }]),
  );
  return { index, damaged: entries.length !== all.length };
}

/** Writes the local copy index in its store format. */
export function formatLocalCopyIndex(index: LocalCopyIndex): string {
  return JSON.stringify({ version: INDEX_VERSION, copies: index });
}

/** Writes the local copy of a document, creating its folder when needed, and records where its file was saved and when, one index update at a time. */
export async function saveLocalCopy(
  folder: string,
  documentId: DocumentId,
  file: Uint8Array,
  sourcePath: string | null,
  savedAt: Date,
): Promise<void> {
  const copyPath = localCopyPath(folder, documentId);
  if (copyPath === null) {
    throw new Error('Invalid document identifier for a local copy.');
  }
  await mkdir(folder, { recursive: true });
  await writeFileSafely(copyPath, file);
  await runInOrder(async () => {
    const indexPath = join(folder, INDEX_FILE);
    const index = await readIndex(indexPath, new Date());
    const entry = { path: sourcePath, savedAt: savedAt.toISOString() };
    await writeFileSafely(indexPath, formatLocalCopyIndex({ ...index, [documentId]: entry }));
  });
}

/** Reads the local copy index from its store, a missing index meaning no copy yet, and sets a damaged index aside under a name ending with the time in milliseconds before it is rewritten, so that what it held can still be recovered; an index that cannot be set aside is only logged and then rewritten with its well-formed entries. */
async function readIndex(indexPath: string, now: Date): Promise<LocalCopyIndex> {
  const { index, damaged } = readIndexText(await readStoredText(indexPath));
  if (damaged) {
    await setDamagedFileAside(indexPath, now, 'The local copy index');
  }
  return index;
}

/** Tells whether an untrusted value is an index entry: a stored path or none, and an ISO instant. */
function isEntry(value: unknown): value is LocalCopyEntry {
  const path: unknown = Reflect.get(Object(value), 'path');
  const savedAt: unknown = Reflect.get(Object(value), 'savedAt');
  return (
    (path === null || isStoredPath(path)) &&
    typeof savedAt === 'string' &&
    ISO_INSTANT.test(savedAt)
  );
}
