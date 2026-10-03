import {
  MAX_CSV_TEXT_UTF16_UNITS,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_TEXT_UTF16_UNITS,
  MAX_RECENT_PROJECTS,
  MAX_UNCOMPRESSED_BYTES,
} from '../core/limits';
import type { ExchangeKind } from '../preload/bridge-contract';

const EXCHANGE_KINDS: readonly ExchangeKind[] = ['json', 'csv'];
const UNITS_PER_CHARACTER = 2;
const MAX_TEXT_UNITS: Readonly<Record<ExchangeKind, number>> = {
  json: MAX_PROJECT_TEXT_UTF16_UNITS,
  csv: MAX_CSV_TEXT_UTF16_UNITS,
};

/** Reads the Yjs state a page sends to be saved: non-empty bytes within the uncompressed size limit, or null. */
export function readProjectState(value: unknown): Uint8Array | null {
  const isState =
    value instanceof Uint8Array && value.length > 0 && value.length <= MAX_UNCOMPRESSED_BYTES;
  return isState ? value : null;
}

/** Reads the kind of an import or export a page asks for, or null. */
export function readExchangeKind(value: unknown): ExchangeKind | null {
  return EXCHANGE_KINDS.find((kind) => kind === value) ?? null;
}

/** Reads the text of an export a page sends, within the import limit of its kind so that every export can be read back, or null. */
export function readExportText(value: unknown, kind: ExchangeKind): string | null {
  return typeof value === 'string' && value.length <= MAX_TEXT_UNITS[kind] ? value : null;
}

/** Reads the position of a recent project a page asks to open, or null. */
export function readRecentIndex(value: unknown): number | null {
  const isIndex =
    Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= 0 &&
    value < MAX_RECENT_PROJECTS;
  return isIndex ? value : null;
}

/** Reads the project name a page suggests for a file to save, or null when it is not a string within the length of a project name. */
export function readSuggestedName(value: unknown): string | null {
  const short =
    typeof value === 'string' && value.length <= MAX_PROJECT_NAME_LENGTH * UNITS_PER_CHARACTER;
  return short && Array.from(value).length <= MAX_PROJECT_NAME_LENGTH ? value : null;
}
