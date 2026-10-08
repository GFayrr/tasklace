import { isQuarterHours } from '../../time';
import { MAX_DEPENDENCIES, MAX_SEGMENTS_PER_TASK } from '../../limits';
import type { TaskSegment } from '../../model/project';
import { failure, success, type Result } from '../../result';
import {
  createIssueList,
  type IssueList,
  type ValidationIssue,
} from '../../validation/validation-issues';
import { restoreFormula } from './csv-cells';
import { readHeader, type CsvColumn } from './csv-columns';
import type { ColumnSelector, CsvRow, CsvTable } from './csv-text';
import {
  createDateParser,
  type CsvDate,
  type DateParser,
  type RegionalFormat,
} from './regional-format';
import {
  parseBlocks,
  parsePredecessors,
  readWbsNumber,
  type BlockWait,
  type PredecessorReference,
  type WbsNumber,
} from './task-notations';

export type CsvWarningCode =
  | 'UNKNOWN_COLUMN'
  | 'EXTRA_CELLS'
  | 'IGNORED_VALUE'
  | 'IGNORED_LINKS'
  | 'START_DIFFERS'
  | 'END_DIFFERS'
  | 'PROGRESS_DIFFERS';

export interface CsvWarning {
  readonly path: string;
  readonly code: CsvWarningCode;
}

export interface ParsedRow {
  readonly rowNumber: number;
  readonly wbs: WbsNumber | null;
  readonly name: string;
  readonly start: CsvDate | null;
  readonly end: CsvDate | null;
  readonly durationHours: number | null;
  readonly progressPercent: number | null;
  readonly predecessors: readonly PredecessorReference[];
  readonly tagName: string | null;
  readonly blocks: readonly TaskSegment[] | null;
  readonly blockWaits: readonly BlockWait[];
}

export interface ParsedTable {
  readonly rows: readonly ParsedRow[];
  readonly warnings: readonly CsvWarning[];
}

type ColumnIndexes = ReadonlyMap<CsvColumn, number>;

type CellIssue = 'INVALID_NOTATION' | 'INVALID_NUMBER' | 'INVALID_DATE' | 'TOO_MANY_ITEMS';

interface RowContext {
  readonly columns: ColumnIndexes;
  readonly parseDate: DateParser;
  readonly issues: IssueList;
  readonly warnings: CsvWarning[];
  readonly budget: { remainingPredecessors: number };
}

const DURATION_PATTERN = /^(\d{1,9}(?:[.,]\d{1,2})?)\s*h?$/i;
const PROGRESS_PATTERN = /^(\d{1,9})\s*%?$/;
const DECIMAL_RADIX = 10;

/** Returns the location of a row, or of one of its cells, by its row number in the spreadsheet, the header being row 1. */
export function rowPath(rowNumber: number, column?: CsvColumn): string {
  const row = `rows[${String(rowNumber)}]`;
  return column === undefined ? row : `${row}.${column}`;
}

/** Selects the columns whose header names a known column in a supported unit, so that the reader skips the cells of every other column. */
export const selectKnownColumns: ColumnSelector = (header) => readHeader(header).kind === 'column';

/** Reads the cells of every row into typed values, or lists each unreadable cell and column at its location, with warnings about what is ignored. */
export function readTable(
  table: CsvTable,
  format: RegionalFormat,
): Result<ParsedTable, readonly ValidationIssue[]> {
  const issues = createIssueList();
  const warnings: CsvWarning[] = [];
  const columns = readColumns(table.header, issues, warnings);
  const context: RowContext = {
    columns,
    parseDate: createDateParser(format),
    issues,
    warnings,
    budget: { remainingPredecessors: MAX_DEPENDENCIES },
  };
  const rows = table.rows.map((row) => readRow(row, context));
  warnings.push(...blankColumnWarnings(table));
  return issues.issues.length > 0 ? failure(issues.issues) : success({ rows, warnings });
}

/** Finds the known columns of a header, warning about unknown non-blank ones and refusing any repeated column, an unsupported unit or a missing name column. */
function readColumns(
  header: readonly string[],
  issues: IssueList,
  warnings: CsvWarning[],
): ColumnIndexes {
  const columns = new Map<CsvColumn, number>();
  header.forEach((cell, index) => {
    const reading = readHeader(cell);
    if (reading.kind === 'unknown') {
      reportUnknownColumn(cell, index, warnings);
    } else if (columns.has(reading.column)) {
      issues.add(`columns.${reading.column}`, 'DUPLICATE_ENTRY');
    } else if (reading.kind === 'unsupportedUnit') {
      issues.add(`columns.${reading.column}`, 'UNSUPPORTED_UNIT');
    } else {
      columns.set(reading.column, index);
    }
  });
  if (!columns.has('name')) {
    issues.add('columns.name', 'MISSING_FIELD');
  }
  return columns;
}

/** Reads the cells of one row into typed values, spending the predecessors and block waits it holds from the budget of the whole table. */
function readRow(row: CsvRow, context: RowContext): ParsedRow {
  if (row.hasExtraCells) {
    context.warnings.push({ path: rowPath(row.rowNumber), code: 'EXTRA_CELLS' });
  }
  /** Returns the text of a cell of the row in a column, its formula guard removed, or an empty text for a column the table lacks. */
  const cell = (column: CsvColumn): string => {
    const index = context.columns.get(column);
    return index === undefined ? '' : restoreFormula(row.cells[index] ?? '');
  };
  /** Reads a cell of the row in a column, recording the problem found when it cannot be read. */
  const read = <T>(column: CsvColumn, parse: (text: string) => Result<T, CellIssue>): T | null =>
    readCell(cell(column), rowPath(row.rowNumber, column), parse, context.issues);
  const { budget, parseDate } = context;
  const predecessors =
    read('predecessors', (text) => parsePredecessors(text, budget.remainingPredecessors)) ?? [];
  budget.remainingPredecessors -= predecessors.length;
  const blocks = read('blocks', (text) =>
    parseBlocks(text, MAX_SEGMENTS_PER_TASK, budget.remainingPredecessors),
  );
  budget.remainingPredecessors -= blocks?.waits.length ?? 0;
  return {
    rowNumber: row.rowNumber,
    wbs: read('wbs', parseWbs),
    name: cell('name'),
    start: read('start', parseDate),
    end: read('end', parseDate),
    durationHours: read('duration', parseDuration),
    progressPercent: read('progress', (text) => parseNumber(text, PROGRESS_PATTERN)),
    predecessors,
    tagName: read('tag', success),
    blocks: blocks?.segments ?? null,
    blockWaits: blocks?.waits ?? [],
  };
}

/** Reads one trimmed cell with a parser, an empty cell giving null and an unreadable one an issue at its location. */
function readCell<T>(
  text: string,
  path: string,
  parse: (text: string) => Result<T, CellIssue>,
  issues: IssueList,
): T | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = parse(trimmed);
  if (!parsed.ok) {
    issues.add(path, parsed.error);
    return null;
  }
  return parsed.value;
}

/** Warns about a header cell that names no known column, blank headers being checked with their rows instead. */
function reportUnknownColumn(cell: string, index: number, warnings: CsvWarning[]): void {
  if (cell.trim() !== '') {
    warnings.push({ path: columnPath(index), code: 'UNKNOWN_COLUMN' });
  }
}

/** Warns about every column without header that still holds a value in some row, since that value is ignored. */
function blankColumnWarnings(table: CsvTable): CsvWarning[] {
  return table.header.flatMap((cell, index): CsvWarning[] =>
    cell.trim() === '' && table.filledBlankColumns.has(index)
      ? [{ path: columnPath(index), code: 'UNKNOWN_COLUMN' }]
      : [],
  );
}

/** Returns the location of a column by its position in the spreadsheet, the first column being 1. */
function columnPath(index: number): string {
  return `columns[${String(index + 1)}]`;
}

/** Reads a WBS number cell. */
function parseWbs(text: string): Result<WbsNumber, CellIssue> {
  const wbs = readWbsNumber(text);
  return wbs === null ? failure('INVALID_NOTATION') : success(wbs);
}

/** Reads a duration in hours made of whole quarter hours, with a comma or a dot as decimal mark and an optional unit. */
function parseDuration(text: string): Result<number, CellIssue> {
  const match = DURATION_PATTERN.exec(text);
  const hours = match === null ? Number.NaN : Number((match[1] ?? '').replace(',', '.'));
  return isQuarterHours(hours) ? success(hours) : failure('INVALID_NUMBER');
}

/** Reads a whole number written with digits and an optional unit. */
function parseNumber(text: string, pattern: RegExp): Result<number, CellIssue> {
  const match = pattern.exec(text);
  return match === null
    ? failure('INVALID_NUMBER')
    : success(Number.parseInt(match[1] ?? '', DECIMAL_RADIX));
}
