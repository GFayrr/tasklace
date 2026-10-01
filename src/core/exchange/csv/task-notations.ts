import { MAX_HIERARCHY_DEPTH } from '../../limits';
import type { DependencyType, TaskSegment } from '../../model/project';
import { failure, success, type Result } from '../../result';
import { isQuarterHours } from '../../time';

export type WbsNumber = string;

export interface PredecessorReference {
  readonly wbs: WbsNumber;
  readonly type: DependencyType;
  readonly lagHours: number;
}

export type NotationError = 'INVALID_NOTATION' | 'TOO_MANY_ITEMS';

const TYPE_CODES: Readonly<Record<DependencyType, string>> = {
  finishToStart: 'FS',
  startToStart: 'SS',
  finishToFinish: 'FF',
  startToFinish: 'SF',
};
const TYPE_BY_CODE: ReadonlyMap<string, DependencyType> = new Map([
  ['FS', 'finishToStart'],
  ['SS', 'startToStart'],
  ['FF', 'finishToFinish'],
  ['SF', 'startToFinish'],
]);
const WBS_PATTERN = /^\d{1,9}(?:\.\d{1,9})*$/;
const PREDECESSOR_PATTERN =
  /^(\d{1,9}(?:\.\d{1,9})*)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d{1,9}(?:\.\d{1,2})?)\s*h?)?$/i;
const FIRST_BLOCK_PATTERN = /^(\d{1,9}(?:\.\d{1,2})?)\s*h$/i;
const NEXT_BLOCK_PATTERN = /^\+\s*(\d{1,9})\s*d\s+(\d{1,9}(?:\.\d{1,2})?)\s*h$/i;
const LIST_ITEM = /[^;,]*/y;
const MAX_ITEM_LENGTH = 256;
const WBS_SEPARATOR = '.';
const DECIMAL_RADIX = 10;
const DEFAULT_TYPE: DependencyType = 'finishToStart';
const WRITTEN_LIST_SEPARATOR = ', ';
const WRITTEN_BLOCK_SEPARATOR = '; ';

/** Reads a WBS number such as "1.2" into its canonical form without leading zeros, or null when it is not one. */
export function readWbsNumber(text: string): WbsNumber | null {
  const trimmed = text.trim();
  if (trimmed.length > MAX_ITEM_LENGTH || !WBS_PATTERN.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split(WBS_SEPARATOR);
  if (parts.length > MAX_HIERARCHY_DEPTH) {
    return null;
  }
  return parts.map((part) => String(Number.parseInt(part, DECIMAL_RADIX))).join(WBS_SEPARATOR);
}

/** Orders two canonical WBS numbers as in the task table: 1, 1.1, 1.2, 2, 10. */
export function compareWbsNumbers(left: WbsNumber, right: WbsNumber): number {
  const leftParts = left.split(WBS_SEPARATOR);
  const rightParts = right.split(WBS_SEPARATOR);
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    const difference = toNumber(leftParts[index]) - toNumber(rightParts[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftParts.length - rightParts.length;
}

/** Returns the WBS number of the parent of a task, or null for a task at the top level. */
export function parentWbsNumber(wbs: WbsNumber): WbsNumber | null {
  const last = wbs.lastIndexOf(WBS_SEPARATOR);
  return last < 0 ? null : wbs.slice(0, last);
}

/** Writes the predecessors of a task as "1.2, 3SS+2h": WBS number, type unless finish-to-start without lag, and lag. */
export function formatPredecessors(references: readonly PredecessorReference[]): string {
  return references.map(formatPredecessor).join(WRITTEN_LIST_SEPARATOR);
}

/** Reads a list of predecessors such as "1.2, 3SS+2h", finish-to-start without lag being the default. */
export function parsePredecessors(
  text: string,
  maxCount: number,
): Result<PredecessorReference[], NotationError> {
  const items = splitList(text, maxCount);
  if (items === null) {
    return failure('TOO_MANY_ITEMS');
  }
  const references: PredecessorReference[] = [];
  for (const item of items) {
    const reference = parsePredecessor(item);
    if (reference === null) {
      return failure('INVALID_NOTATION');
    }
    references.push(reference);
  }
  return success(references);
}

/** Writes the blocks of a split task as "4h; +2d 3.5h", each later block after its gap in calendar days, hours with a dot as decimal mark. */
export function formatBlocks(segments: readonly TaskSegment[]): string {
  return segments
    .map((segment, index) =>
      index === 0
        ? `${String(segment.durationHours)}h`
        : `+${String(segment.gapDaysBefore)}d ${String(segment.durationHours)}h`,
    )
    .join(WRITTEN_BLOCK_SEPARATOR);
}

/** Reads the blocks of a split task written as "4h; +2d 3h". */
export function parseBlocks(text: string, maxCount: number): Result<TaskSegment[], NotationError> {
  const items = splitList(text, maxCount);
  if (items === null) {
    return failure('TOO_MANY_ITEMS');
  }
  const segments: TaskSegment[] = [];
  for (const [index, item] of items.entries()) {
    const segment = parseBlock(item, index === 0);
    if (segment === null) {
      return failure('INVALID_NOTATION');
    }
    segments.push(segment);
  }
  return segments.length === 0 ? failure('INVALID_NOTATION') : success(segments);
}

/** Splits a cell into its trimmed, non-empty items in a single pass, or returns null as soon as there are more than allowed, so that no cell can make it keep more items than the limit. */
function splitList(text: string, maxCount: number): string[] | null {
  const items: string[] = [];
  for (let position = 0; position <= text.length; position = LIST_ITEM.lastIndex + 1) {
    LIST_ITEM.lastIndex = position;
    LIST_ITEM.test(text);
    const item = text.slice(position, LIST_ITEM.lastIndex).trim();
    if (item !== '' && items.length === maxCount) {
      return null;
    }
    if (item !== '') {
      items.push(item);
    }
  }
  return items;
}

/** Writes one predecessor. */
function formatPredecessor(reference: PredecessorReference): string {
  if (reference.type === DEFAULT_TYPE && reference.lagHours === 0) {
    return reference.wbs;
  }
  const lag =
    reference.lagHours === 0
      ? ''
      : `${reference.lagHours > 0 ? '+' : '-'}${String(Math.abs(reference.lagHours))}h`;
  return `${reference.wbs}${TYPE_CODES[reference.type]}${lag}`;
}

/** Reads one predecessor, or returns null when it is not well written, an overlong item being refused before any pattern runs. */
function parsePredecessor(item: string): PredecessorReference | null {
  const match = item.length > MAX_ITEM_LENGTH ? null : PREDECESSOR_PATTERN.exec(item);
  const wbs = match === null ? null : readWbsNumber(match[1] ?? '');
  if (match === null || wbs === null) {
    return null;
  }
  const [, , code, sign, lag] = match;
  const type = code === undefined ? DEFAULT_TYPE : TYPE_BY_CODE.get(code.toUpperCase());
  if (type === undefined) {
    return null;
  }
  const magnitude = lag === undefined ? 0 : Number(lag);
  if (!isQuarterHours(magnitude)) {
    return null;
  }
  return { wbs, type, lagHours: sign === '-' ? -magnitude : magnitude };
}

/** Reads one block, the first one having no gap before it, or returns null when it is not well written or overlong. */
function parseBlock(item: string, isFirst: boolean): TaskSegment | null {
  if (item.length > MAX_ITEM_LENGTH) {
    return null;
  }
  if (isFirst) {
    const first = FIRST_BLOCK_PATTERN.exec(item);
    return first === null ? null : quarterBlock(Number(first[1]), 0);
  }
  const next = NEXT_BLOCK_PATTERN.exec(item);
  return next === null ? null : quarterBlock(Number(next[2]), toNumber(next[1]));
}

/** Builds a block whose duration is a whole number of quarter hours, or returns null. */
function quarterBlock(durationHours: number, gapDaysBefore: number): TaskSegment | null {
  return isQuarterHours(durationHours) ? { durationHours, gapDaysBefore } : null;
}

/** Converts decimal digits into a number. */
function toNumber(text: string | undefined): number {
  return Number.parseInt(text ?? '', DECIMAL_RADIX);
}
