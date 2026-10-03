import { normalize } from 'node:path';
import { MAX_RECENT_PROJECTS } from '../core/limits';
import { writeFileSafely } from './safe-write';
import { isStoredPath, parseStoredJson, readStoredText, setDamagedFileAside } from './stored-files';

export interface RecentStoreReading {
  readonly paths: string[];
  readonly damaged: boolean;
}

const STORE_VERSION = 1;

/** Parses the untrusted text of the recent projects store, keeping only well-formed absolute paths, normalized and each once, and tells whether anything had to be dropped, an empty text, as read for a missing store, counting as undamaged. */
export function readRecentStore(text: string): RecentStoreReading {
  if (text === '') {
    return { paths: [], damaged: false };
  }
  const data = parseStoredJson(text);
  const paths: unknown = Reflect.get(Object(data), 'paths');
  if (Reflect.get(Object(data), 'version') !== STORE_VERSION || !Array.isArray(paths)) {
    return { paths: [], damaged: true };
  }
  const kept = paths.filter(isStoredPath);
  return {
    paths: withoutDuplicates(kept.map((path) => normalize(path))),
    damaged: kept.length !== paths.length,
  };
}

/** Puts a project first in the recent list, its path normalized, without duplicate and within the limit. */
export function withRecentProject(paths: readonly string[], path: string): string[] {
  return withoutDuplicates([normalize(path), ...paths]);
}

/** Keeps the first occurrence of each path, within the limit of the recent list. */
function withoutDuplicates(paths: readonly string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_RECENT_PROJECTS);
}

/** Writes the recent list in its store format. */
export function formatRecentProjects(paths: readonly string[]): string {
  return JSON.stringify({ version: STORE_VERSION, paths });
}

/** Reads the recent projects from their store, a missing store meaning none, and sets a damaged store aside before it is rewritten. */
export async function readRecentProjects(storePath: string): Promise<string[]> {
  const { paths, damaged } = readRecentStore(await readStoredText(storePath));
  if (damaged) {
    await setDamagedFileAside(storePath, new Date(), 'The list of recent projects');
  }
  return paths;
}

/** Records a project as the most recently opened one. */
export async function recordRecentProject(storePath: string, path: string): Promise<string[]> {
  const paths = withRecentProject(await readRecentProjects(storePath), path);
  await writeFileSafely(storePath, formatRecentProjects(paths));
  return paths;
}
