import { MAX_HIERARCHY_DEPTH, MAX_SEGMENTS_PER_TASK } from '../../limits';
import type { DependencyType, TaskSegment } from '../../model/project';
import { failure, success, type Result } from '../../result';
import { formatDateTime, parseDateTime } from '../../civil-format';
import { isQuarterHours, type ProjectHour } from '../../time';

export type WbsNumber = string;

export interface PredecessorReference {
  readonly wbs: WbsNumber;
  readonly block: number | null;
  readonly type: DependencyType;
  readonly lagHours: number;
}

export interface BlockWait {
  readonly block: number;
  readonly reference: PredecessorReference;
}

export interface ParsedBlocks {
  readonly segments: readonly TaskSegment[];
  readonly waits: readonly BlockWait[];
}

export type NotationError = 'INVALID_NOTATION' | 'TOO_MANY_ITEMS' | 'INVALID_DATE';

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
  /^(\d{1,9}(?:\.\d{1,9})*)\s*(?:#\s*(\d{1,3}))?\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d{1,9}(?:\.\d{1,2})?)\s*h?)?$/i;
const FIRST_BLOCK_PATTERN = /^(\d{1,9}(?:\.\d{1,2})?)\s*h$/i;
const NEXT_BLOCK_PATTERN =
  /^\+\s*(\d{1,9})\s*d\s+(\d{1,9}(?:\.\d{1,2})?)\s*h(?:\s+from\s+(\d{4}-\d{2}-\d{2}t\d{2}:\d{2}))?$/i;
const LIST_ITEM = /[^;,]*/y;
const MAX_ITEM_LENGTH = 256;
const WBS_SEPARATOR = '.';
const DECIMAL_RADIX = 10;
const DEFAULT_TYPE: DependencyType = 'finishToStart';
const WRITTEN_LIST_SEPARATOR = ', ';
const WRITTEN_BLOCK_SEPARATOR = '; ';
const BLOCK_MARK = '#';
const WAIT_KEYWORD = ' after ';
const START_KEYWORD = ' from ';
const WAIT_KEYWORD_PATTERN = /\safter\s/i;
const WAIT_SEPARATOR = '&';
const PARTS_BESIDE_SEPARATORS = 2;
const WRITTEN_WAIT_SEPARATOR = ' & ';

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

/** Writes the predecessors of a task as "1.2, 3#2SS+2h": WBS number, block if any, type unless finish-to-start without lag, and lag. */
export function formatPredecessors(references: readonly PredecessorReference[]): string {
  return references.map(formatPredecessor).join(WRITTEN_LIST_SEPARATOR);
}

/** Reads a list of predecessors such as "1.2, 3#2SS+2h", finish-to-start without lag being the default. */
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

/** Writes the blocks of a split task as "4h; +2d 3.5h from 2026-10-05T14:00 after 2.1 & 3#2SS": each later block after its gap in calendar days and its start date if any, hours with a dot as decimal mark, then what the block waits for. */
export function formatBlocks(
  segments: readonly TaskSegment[],
  waits: ReadonlyMap<number, readonly PredecessorReference[]>,
): string {
  return segments
    .map((segment, index) => {
      const start =
        segment.startNoEarlierThan === null
          ? ''
          : `${START_KEYWORD}${formatDateTime(segment.startNoEarlierThan)}`;
      const block =
        index === 0
          ? `${String(segment.durationHours)}h`
          : `+${String(segment.gapDaysBefore)}d ${String(segment.durationHours)}h${start}`;
      const references = waits.get(index) ?? [];
      return references.length === 0
        ? block
        : `${block}${WAIT_KEYWORD}${references.map(formatPredecessor).join(WRITTEN_WAIT_SEPARATOR)}`;
    })
    .join(WRITTEN_BLOCK_SEPARATOR);
}

/** Reads the blocks of a split task written as "4h; +2d 3h from 2026-10-05T14:00 after 2.1 & 3#2SS", spending what the blocks wait for from a budget of references. */
export function parseBlocks(
  text: string,
  maxCount: number,
  maxReferences: number,
): Result<ParsedBlocks, NotationError> {
  const items = splitList(text, maxCount);
  if (items === null) {
    return failure('TOO_MANY_ITEMS');
  }
  const segments: TaskSegment[] = [];
  const waits: BlockWait[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = parseBlockItem(item, index, maxReferences - waits.length);
    if (!parsed.ok) {
      return parsed;
    }
    segments.push(parsed.value.segment);
    waits.push(...parsed.value.waits);
  }
  return segments.length === 0 ? failure('INVALID_NOTATION') : success({ segments, waits });
}

/** Reads one block and what it waits for after the keyword "after", counting the references before splitting them and bounding each part before any pattern runs. */
function parseBlockItem(
  item: string,
  block: number,
  maxReferences: number,
): Result<{ readonly segment: TaskSegment; readonly waits: BlockWait[] }, NotationError> {
  const separators = countOccurrences(item, WAIT_SEPARATOR);
  if (separators > maxReferences) {
    return failure('TOO_MANY_ITEMS');
  }
  if (item.length > MAX_ITEM_LENGTH * (separators + PARTS_BESIDE_SEPARATORS)) {
    return failure('INVALID_NOTATION');
  }
  const keyword = WAIT_KEYWORD_PATTERN.exec(item);
  const head = keyword === null ? item : item.slice(0, keyword.index).trim();
  const parsed =
    head.length > MAX_ITEM_LENGTH
      ? failure('INVALID_NOTATION' as const)
      : parseBlock(head, block === 0);
  if (!parsed.ok) {
    return parsed;
  }
  const segment = parsed.value;
  const references =
    keyword === null
      ? []
      : item
          .slice(keyword.index + keyword[0].length)
          .split(WAIT_SEPARATOR)
          .map((reference) => parsePredecessor(reference.trim()));
  if (references.some((reference) => reference === null)) {
    return failure('INVALID_NOTATION');
  }
  if (references.length > maxReferences) {
    return failure('TOO_MANY_ITEMS');
  }
  const waits = references.flatMap((reference) =>
    reference === null ? [] : [{ block, reference }],
  );
  return success({ segment, waits });
}

/** Counts how many times a character appears in a text, without building anything. */
function countOccurrences(text: string, character: string): number {
  let count = 0;
  for (
    let position = text.indexOf(character);
    position >= 0;
    position = text.indexOf(character, position + 1)
  ) {
    count += 1;
  }
  return count;
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

/** Writes one predecessor, a block being numbered from 1 after the WBS number of its task. */
function formatPredecessor(reference: PredecessorReference): string {
  const source =
    reference.block === null
      ? reference.wbs
      : `${reference.wbs}${BLOCK_MARK}${String(reference.block + 1)}`;
  if (reference.type === DEFAULT_TYPE && reference.lagHours === 0) {
    return source;
  }
  const lag =
    reference.lagHours === 0
      ? ''
      : `${reference.lagHours > 0 ? '+' : '-'}${String(Math.abs(reference.lagHours))}h`;
  return `${source}${TYPE_CODES[reference.type]}${lag}`;
}

/** Reads one predecessor, or returns null when it is not well written, an overlong item being refused before any pattern runs. */
function parsePredecessor(item: string): PredecessorReference | null {
  const match = item.length > MAX_ITEM_LENGTH ? null : PREDECESSOR_PATTERN.exec(item);
  const wbs = match === null ? null : readWbsNumber(match[1] ?? '');
  if (match === null || wbs === null) {
    return null;
  }
  const [, , blockNumber, code, sign, lag] = match;
  const type = code === undefined ? DEFAULT_TYPE : TYPE_BY_CODE.get(code.toUpperCase());
  const block = blockNumber === undefined ? null : toNumber(blockNumber) - 1;
  if (type === undefined || (block !== null && (block < 0 || block >= MAX_SEGMENTS_PER_TASK))) {
    return null;
  }
  const magnitude = lag === undefined ? 0 : Number(lag);
  if (!isQuarterHours(magnitude)) {
    return null;
  }
  return { wbs, block, type, lagHours: sign === '-' ? -magnitude : magnitude };
}

/** Reads one block, the first one having no gap or start date of its own, telling a start date that does not exist apart from a block that is not well written. */
function parseBlock(item: string, isFirst: boolean): Result<TaskSegment, NotationError> {
  const written = isFirst ? FIRST_BLOCK_PATTERN.exec(item) : NEXT_BLOCK_PATTERN.exec(item);
  if (written === null) {
    return failure('INVALID_NOTATION');
  }
  const start = written[3] === undefined ? null : parseDateTime(written[3].toUpperCase());
  if (start !== null && !start.ok) {
    return failure('INVALID_DATE');
  }
  const gapDaysBefore = isFirst ? 0 : toNumber(written[1]);
  const durationHours = Number(isFirst ? written[1] : written[2]);
  const segment = quarterBlock(durationHours, gapDaysBefore, start === null ? null : start.value);
  return segment === null ? failure('INVALID_NOTATION') : success(segment);
}

/** Builds a block whose duration is a whole number of quarter hours, or returns null. */
function quarterBlock(
  durationHours: number,
  gapDaysBefore: number,
  startNoEarlierThan: ProjectHour | null = null,
): TaskSegment | null {
  return isQuarterHours(durationHours)
    ? { durationHours, gapDaysBefore, startNoEarlierThan }
    : null;
}

/** Converts decimal digits into a number. */
function toNumber(text: string | undefined): number {
  return Number.parseInt(text ?? '', DECIMAL_RADIX);
}
