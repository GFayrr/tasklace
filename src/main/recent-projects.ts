import { normalize } from 'node:path';
import { hostLabelOf, readRelayAddress } from '../core/collaboration/relay/relay-link';
import { MAX_RECENT_PROJECTS } from '../core/limits';
import { writeFileSafely } from './safe-write';
import { isStoredPath, parseStoredJson, readStoredText, setDamagedFileAside } from './stored-files';

export interface RecentEntry {
  readonly path: string;
  readonly relay: string | null;
}

export interface RecentStoreReading {
  readonly entries: RecentEntry[];
  readonly damaged: boolean;
}

const STORE_VERSION = 2;
const PATHS_ONLY_VERSION = 1;

/** Parses the untrusted text of the recent projects store, older lists of paths included, keeping well-formed entries once each and within the limit, and tells whether it was unreadable or held a malformed entry, a missing store being neither. */
export function readRecentStore(text: string): RecentStoreReading {
  if (text === '') {
    return { entries: [], damaged: false };
  }
  const data = parseStoredJson(text);
  const version: unknown = Reflect.get(Object(data), 'version');
  const listed: unknown =
    version === PATHS_ONLY_VERSION
      ? pathsAsEntries(Reflect.get(Object(data), 'paths'))
      : Reflect.get(Object(data), 'projects');
  if ((version !== STORE_VERSION && version !== PATHS_ONLY_VERSION) || !Array.isArray(listed)) {
    return { entries: [], damaged: true };
  }
  const kept = listed.map(readEntry).filter((entry) => entry !== null);
  return {
    entries: withoutDuplicates(kept.map((entry) => ({ ...entry, path: normalize(entry.path) }))),
    damaged: kept.length !== listed.length,
  };
}

/** Turns the list of paths of the first version of the store into entries shared through no relay, leaving anything that is not a list as it is so that it counts as damaged. */
function pathsAsEntries(paths: unknown): unknown {
  return Array.isArray(paths)
    ? paths.map((path: unknown) => ({ path, relay: null }) as const)
    : paths;
}

/** Reads an untrusted entry of the store: a well-formed absolute path and the relay its plan is shared through, written as the application shows it, or null. */
function readEntry(value: unknown): RecentEntry | null {
  const path: unknown = Reflect.get(Object(value), 'path');
  const relay: unknown = Reflect.get(Object(value), 'relay');
  return isStoredPath(path) && (relay === null || isRelayLabel(relay)) ? { path, relay } : null;
}

/** Tells whether a value is a relay as the application shows it, a host with its port when it has one. */
function isRelayLabel(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const address = readRelayAddress(`wss://${value}`);
  return address.ok && hostLabelOf(address.value) === value;
}

/** Puts a project first in the recent list, its path normalized, without duplicate and within the limit, keeping the relay the list knew for it unless another one is given. */
export function withRecentProject(
  entries: readonly RecentEntry[],
  path: string,
  relay?: string | null,
): RecentEntry[] {
  const normalized = normalize(path);
  const known = entries.find((entry) => entry.path === normalized)?.relay ?? null;
  return withoutDuplicates([
    { path: normalized, relay: relay === undefined ? known : relay },
    ...entries,
  ]);
}

/** Notes the relay a recent project is shared through, or that it is shared through none, leaving its place in the list as it is. */
export function withRelayOf(
  entries: readonly RecentEntry[],
  path: string,
  relay: string | null,
): RecentEntry[] {
  const normalized = normalize(path);
  return entries.map((entry) => (entry.path === normalized ? { path: normalized, relay } : entry));
}

/** Keeps the first entry of each path, within the limit of the recent list. */
function withoutDuplicates(entries: readonly RecentEntry[]): RecentEntry[] {
  const firsts = new Map<string, RecentEntry>();
  for (const entry of entries) {
    if (!firsts.has(entry.path)) {
      firsts.set(entry.path, entry);
    }
  }
  return [...firsts.values()].slice(0, MAX_RECENT_PROJECTS);
}

/** Writes the recent list in its store format. */
export function formatRecentProjects(entries: readonly RecentEntry[]): string {
  return JSON.stringify({ version: STORE_VERSION, projects: entries });
}

/** Reads the recent projects from their store, a missing store meaning none, and sets a damaged store aside then writes its valid entries back at once, so that the next reading finds them, a failed write being only logged. */
export async function readRecentProjects(storePath: string): Promise<RecentEntry[]> {
  const { entries, damaged } = readRecentStore(await readStoredText(storePath));
  if (damaged) {
    await setDamagedFileAside(storePath, new Date(), 'The list of recent projects');
    await writeFileSafely(storePath, formatRecentProjects(entries)).catch((error: unknown) => {
      console.error('The repaired list of recent projects could not be written:', error);
    });
  }
  return entries;
}

/** Records a project as the most recently opened one, with the relay its plan is shared through when it is given. */
export async function recordRecentProject(
  storePath: string,
  path: string,
  relay?: string | null,
): Promise<RecentEntry[]> {
  const entries = withRecentProject(await readRecentProjects(storePath), path, relay);
  await writeFileSafely(storePath, formatRecentProjects(entries));
  return entries;
}

/** Notes in the store the relay a recent project is shared through, or none, writing only when that changes it. */
export async function noteRecentRelay(
  storePath: string,
  path: string,
  relay: string | null,
): Promise<void> {
  const entries = await readRecentProjects(storePath);
  const noted = withRelayOf(entries, path, relay);
  if (noted.some((entry, index) => entry.relay !== entries[index]?.relay)) {
    await writeFileSafely(storePath, formatRecentProjects(noted));
  }
}
