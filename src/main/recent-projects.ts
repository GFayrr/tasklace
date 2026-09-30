import { MAX_RECENT_PROJECTS } from '../core/limits';
import { writeFileSafely } from './safe-write';
import { isStoredPath, parseStoredJson, readStoredText } from './stored-files';

const STORE_VERSION = 1;

/** Reads the untrusted content of the recent projects store, keeping only well-formed absolute paths, a damaged store counting as empty since it only holds shortcuts. */
export function parseRecentProjects(text: string): string[] {
  const data = parseStoredJson(text);
  const paths: unknown = Reflect.get(Object(data), 'paths');
  if (Reflect.get(Object(data), 'version') !== STORE_VERSION || !Array.isArray(paths)) {
    return [];
  }
  return paths.filter(isStoredPath).slice(0, MAX_RECENT_PROJECTS);
}

/** Puts a project first in the recent list, without duplicate and within the limit. */
export function withRecentProject(paths: readonly string[], path: string): string[] {
  return [path, ...paths.filter((known) => known !== path)].slice(0, MAX_RECENT_PROJECTS);
}

/** Writes the recent list in its store format. */
export function formatRecentProjects(paths: readonly string[]): string {
  return JSON.stringify({ version: STORE_VERSION, paths });
}

/** Reads the recent projects from their store, a missing store meaning none. */
export async function readRecentProjects(storePath: string): Promise<string[]> {
  return parseRecentProjects(await readStoredText(storePath));
}

/** Records a project as the most recently opened one. */
export async function recordRecentProject(storePath: string, path: string): Promise<string[]> {
  const paths = withRecentProject(await readRecentProjects(storePath), path);
  await writeFileSafely(storePath, formatRecentProjects(paths));
  return paths;
}
