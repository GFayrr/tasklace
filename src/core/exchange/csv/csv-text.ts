import { failure, success, type Result } from '../../result';

export const CSV_SEPARATORS = [',', ';', '\t'] as const;

export type CsvSeparator = (typeof CSV_SEPARATORS)[number];

export interface CsvRow {
  readonly rowNumber: number;
  readonly cells: readonly string[];
  readonly hasExtraCells: boolean;
}

export interface CsvTable {
  readonly separator: CsvSeparator;
  readonly header: readonly string[];
  readonly rows: readonly CsvRow[];
  readonly filledBlankColumns: ReadonlySet<number>;
}

export type ColumnSelector = (header: string, index: number) => boolean;

export interface CsvLimits {
  readonly maxColumns: number;
  readonly maxRows: number;
}

export type CsvSyntaxError =
  | { readonly code: 'INVALID_CSV'; readonly rowNumber: number }
  | { readonly code: 'TOO_MANY_COLUMNS' }
  | { readonly code: 'TOO_MANY_ROWS' };

type RecordEnd = 'cell' | 'record' | 'text';

interface ReadCell {
  readonly value: string;
  readonly next: number;
  readonly end: RecordEnd;
}

interface ReadRecord {
  readonly cells: readonly string[];
  readonly hasExtraCells: boolean;
  readonly hasSkippedValues: boolean;
  readonly next: number;
  readonly isLast: boolean;
}

interface RecordShape {
  readonly maxCells: number;
  readonly kept: readonly boolean[];
  readonly lastKept: number;
  readonly blank: readonly boolean[];
}

const QUOTE = '"';
const ESCAPED_QUOTE = '""';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const LINE_END = CARRIAGE_RETURN + LINE_FEED;
const HEADER_ROW_NUMBER = 1;
const QUOTES_PER_SLICE = 65_536;
const HEADER_SCAN_LENGTH = 65_536;
const QUOTED_SECTION = /"[^"]*"/g;
const LINE_BREAK = /[\r\n]/;
const BLANK_LINE: Readonly<Record<CsvSeparator, RegExp>> = {
  ',': /[, ]*(?:\r\n|\n|\r)/y,
  ';': /[; ]*(?:\r\n|\n|\r)/y,
  '\t': /[\t ]*(?:\r\n|\n|\r)/y,
};
const SPECIAL_CHARACTERS: Readonly<Record<CsvSeparator, RegExp>> = {
  ',': /[,"\r\n]/,
  ';': /[;"\r\n]/,
  '\t': /[\t"\r\n]/,
};
const UNQUOTED_CELL: Readonly<Record<CsvSeparator, RegExp>> = {
  ',': /[^,\r\n]*/y,
  ';': /[^;\r\n]*/y,
  '\t': /[^\t\r\n]*/y,
};

/** Keeps every column of a table. */
export const keepAllColumns: ColumnSelector = () => true;

/** Reads CSV text into a header and its non-empty rows, numbered as in a spreadsheet, keeping the cells of the selected columns, empty for skipped columns before the last selected one, and noting which columns without header hold a value in some row. */
export function parseCsv(
  text: string,
  fallbackSeparator: CsvSeparator,
  limits: CsvLimits,
  selectColumn: ColumnSelector,
): Result<CsvTable, CsvSyntaxError> {
  const separator = detectSeparator(text, fallbackSeparator);
  const headerShape = shapeOf(
    Array.from({ length: limits.maxColumns + 1 }, () => ''),
    keepAllColumns,
  );
  const header = readRecord(text, 0, separator, headerShape, new Set());
  if (!header.ok) {
    return header;
  }
  if (header.value.cells.length > limits.maxColumns) {
    return failure({ code: 'TOO_MANY_COLUMNS' });
  }
  const filledBlankColumns = new Set<number>();
  const shape = shapeOf(header.value.cells, selectColumn);
  const rows = readRows(text, header.value, separator, shape, limits.maxRows, filledBlankColumns);
  if (!rows.ok) {
    return rows;
  }
  return success({ separator, header: header.value.cells, rows: rows.value, filledBlankColumns });
}

/** Describes which cells of the records under a header to keep and which columns have no header, a record keeping no cell beyond the header. */
function shapeOf(header: readonly string[], selectColumn: ColumnSelector): RecordShape {
  const kept = header.map(selectColumn);
  return {
    maxCells: header.length,
    kept,
    lastKept: kept.lastIndexOf(true),
    blank: header.map((cell) => cell.trim() === ''),
  };
}

/** Writes records as CSV text with Windows line ends, quoting only the cells that need it. */
export function writeCsv(records: readonly (readonly string[])[], separator: CsvSeparator): string {
  return records
    .map((cells) => cells.map((cell) => quoteCell(cell, separator)).join(separator) + LINE_END)
    .join('');
}

/** Picks the separator used most often in the header line outside quotes, the regional one winning ties, looking only at the start of the text where a real header lies. */
function detectSeparator(text: string, fallbackSeparator: CsvSeparator): CsvSeparator {
  const unquoted = text.slice(0, HEADER_SCAN_LENGTH).replace(QUOTED_SECTION, '');
  const line = unquoted.split(LINE_BREAK, 1)[0] ?? '';
  const counts = CSV_SEPARATORS.map((separator) => line.split(separator).length - 1);
  const highest = Math.max(...counts);
  if (counts[CSV_SEPARATORS.indexOf(fallbackSeparator)] === highest) {
    return fallbackSeparator;
  }
  return CSV_SEPARATORS[counts.indexOf(highest)] ?? fallbackSeparator;
}

/** Reads the data rows after the header, skipping empty ones, those made only of separators and spaces without even reading their cells, and failing as soon as there are more rows than the limit. */
function readRows(
  text: string,
  header: ReadRecord,
  separator: CsvSeparator,
  shape: RecordShape,
  maxRows: number,
  filledBlankColumns: Set<number>,
): Result<CsvRow[], CsvSyntaxError> {
  const rows: CsvRow[] = [];
  let position = header.next;
  let isLast = header.isLast;
  for (let rowNumber = HEADER_ROW_NUMBER + 1; !isLast; rowNumber += 1) {
    const blankLineEnd = endOfBlankLine(text, position, separator);
    if (blankLineEnd !== null) {
      position = blankLineEnd;
      isLast = position >= text.length;
      continue;
    }
    const record = readRecord(text, position, separator, shape, filledBlankColumns, rowNumber);
    if (!record.ok) {
      return record;
    }
    ({ next: position, isLast } = record.value);
    if (!isEmptyRecord(record.value)) {
      rows.push({
        rowNumber,
        cells: record.value.cells,
        hasExtraCells: record.value.hasExtraCells,
      });
    }
    if (rows.length > maxRows) {
      return failure({ code: 'TOO_MANY_ROWS' });
    }
  }
  return success(rows);
}

/** Returns where a line made only of separators and spaces ends, just after its line break, or null for any other line, including such a line that ends the text without line break. */
function endOfBlankLine(text: string, start: number, separator: CsvSeparator): number | null {
  const pattern = BLANK_LINE[separator];
  pattern.lastIndex = start;
  return pattern.test(text) ? pattern.lastIndex : null;
}

/** Tells whether a record holds only blank cells, as the separator-only lines spreadsheets leave behind. */
function isEmptyRecord(record: ReadRecord): boolean {
  return (
    !record.hasExtraCells &&
    !record.hasSkippedValues &&
    record.cells.every((cell) => cell.trim() === '')
  );
}

/** Reads one record from a position, keeping the cells its shape selects, noting whether non-blank cells were skipped or lie beyond the header, and adding to a set the columns without header that hold a value. */
function readRecord(
  text: string,
  start: number,
  separator: CsvSeparator,
  shape: RecordShape,
  filledBlankColumns: Set<number>,
  rowNumber = HEADER_ROW_NUMBER,
): Result<ReadRecord, CsvSyntaxError> {
  const cells: string[] = [];
  let hasExtraCells = false;
  let hasSkippedValues = false;
  let position = start;
  for (let index = 0; ; index += 1) {
    const cell = readCell(text, position, separator);
    if (cell === null) {
      return failure({ code: 'INVALID_CSV', rowNumber });
    }
    const kept = shape.kept[index] === true;
    const isBlankColumn = shape.blank[index] === true;
    const holdsValue = (!kept || isBlankColumn) && cell.value.trim() !== '';
    hasExtraCells ||= index >= shape.maxCells && holdsValue;
    hasSkippedValues ||= !kept && index < shape.maxCells && holdsValue;
    if (holdsValue && isBlankColumn) {
      filledBlankColumns.add(index);
    }
    if (index <= shape.lastKept) {
      cells.push(kept ? cell.value : '');
    }
    position = cell.next;
    if (cell.end !== 'cell') {
      const isLast = cell.end === 'text';
      return success({ cells, hasExtraCells, hasSkippedValues, next: position, isLast });
    }
  }
}

/** Reads one cell from a position, an unquoted one being matched by a sticky regular expression, or returns null for a badly quoted cell. */
function readCell(text: string, start: number, separator: CsvSeparator): ReadCell | null {
  if (text.charAt(start) === QUOTE) {
    return readQuotedCell(text, start + 1, separator);
  }
  const pattern = UNQUOTED_CELL[separator];
  pattern.lastIndex = start;
  pattern.test(text);
  const end = pattern.lastIndex;
  return finishCell(text, text.slice(start, end), end, separator);
}

/** Reads a quoted cell whose content starts at a position, doubled quotes standing for one quote, decoding the content in slices of a bounded number of quotes so that a cell made of quotes never needs more memory than its text. */
function readQuotedCell(text: string, start: number, separator: CsvSeparator): ReadCell | null {
  const slices: string[] = [];
  let sliceStart = start;
  let position = start;
  for (let pairs = 1; ; pairs += 1) {
    const quote = text.indexOf(QUOTE, position);
    if (quote < 0) {
      return null;
    }
    if (text.charAt(quote + 1) !== QUOTE) {
      slices.push(unescapeQuotes(text.slice(sliceStart, quote)));
      return closeQuotedCell(text, slices.join(''), quote + 1, separator);
    }
    position = quote + ESCAPED_QUOTE.length;
    if (pairs % QUOTES_PER_SLICE === 0) {
      slices.push(unescapeQuotes(text.slice(sliceStart, position)));
      sliceStart = position;
    }
  }
}

/** Turns the doubled quotes of a slice of quoted content back into single quotes, splitting and joining so that the result is one flat string rather than a chain of pieces. */
function unescapeQuotes(slice: string): string {
  return slice.split(ESCAPED_QUOTE).join(QUOTE);
}

/** Ends a quoted cell at the character after its closing quote, which must be a separator, a line break or the end of the text. */
function closeQuotedCell(
  text: string,
  value: string,
  after: number,
  separator: CsvSeparator,
): ReadCell | null {
  const atEnd = after === text.length || isCellEnd(text.charAt(after), separator);
  return atEnd ? finishCell(text, value, after, separator) : null;
}

/** Builds a cell ending at a position that holds a separator, a line end or the end of the text. */
function finishCell(text: string, value: string, end: number, separator: CsvSeparator): ReadCell {
  const character = text.charAt(end);
  if (end >= text.length) {
    return { value, next: end, end: 'text' };
  }
  if (character === separator) {
    return { value, next: end + 1, end: 'cell' };
  }
  const lineEndLength = text.startsWith(LINE_END, end) ? LINE_END.length : 1;
  const next = end + lineEndLength;
  return { value, next, end: next >= text.length ? 'text' : 'record' };
}

/** Tells whether a character may follow a closing quote: the separator or a line break. */
function isCellEnd(character: string, separator: CsvSeparator): boolean {
  return character === separator || character === LINE_FEED || character === CARRIAGE_RETURN;
}

/** Quotes a cell holding a separator, a quote or a line break, doubling its quotes. */
function quoteCell(cell: string, separator: CsvSeparator): string {
  return SPECIAL_CHARACTERS[separator].test(cell)
    ? QUOTE + cell.replaceAll(QUOTE, ESCAPED_QUOTE) + QUOTE
    : cell;
}
