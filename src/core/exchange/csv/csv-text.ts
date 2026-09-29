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
}

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
  readonly next: number;
  readonly isLast: boolean;
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
const UNQUOTED_CELL: Readonly<Record<CsvSeparator, RegExp>> = {
  ',': /[^,\r\n]*/y,
  ';': /[^;\r\n]*/y,
  '\t': /[^\t\r\n]*/y,
};

/** Reads CSV text into a header and its non-empty rows, numbered as in a spreadsheet, keeping at most one cell per header column. */
export function parseCsv(
  text: string,
  fallbackSeparator: CsvSeparator,
  limits: CsvLimits,
): Result<CsvTable, CsvSyntaxError> {
  const separator = detectSeparator(text, fallbackSeparator);
  const header = readRecord(text, 0, separator, limits.maxColumns + 1, HEADER_ROW_NUMBER);
  if (!header.ok) {
    return header;
  }
  if (header.value.cells.length > limits.maxColumns) {
    return failure({ code: 'TOO_MANY_COLUMNS' });
  }
  const rows = readRows(text, header.value, separator, limits.maxRows);
  return rows.ok ? success({ separator, header: header.value.cells, rows: rows.value }) : rows;
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

/** Reads the data rows after the header, skipping empty ones and failing as soon as there are more rows than the limit. */
function readRows(
  text: string,
  header: ReadRecord,
  separator: CsvSeparator,
  maxRows: number,
): Result<CsvRow[], CsvSyntaxError> {
  const rows: CsvRow[] = [];
  let position = header.next;
  let isLast = header.isLast;
  for (let rowNumber = HEADER_ROW_NUMBER + 1; !isLast; rowNumber += 1) {
    const record = readRecord(text, position, separator, header.cells.length, rowNumber);
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

/** Tells whether a record holds only blank cells, as the separator-only lines spreadsheets leave behind. */
function isEmptyRecord(record: ReadRecord): boolean {
  return !record.hasExtraCells && record.cells.every((cell) => cell.trim() === '');
}

/** Reads one record from a position, keeping at most a number of cells and noting whether non-empty cells were dropped. */
function readRecord(
  text: string,
  start: number,
  separator: CsvSeparator,
  maxCells: number,
  rowNumber: number,
): Result<ReadRecord, CsvSyntaxError> {
  const cells: string[] = [];
  let hasExtraCells = false;
  let position = start;
  for (;;) {
    const cell = readCell(text, position, separator);
    if (cell === null) {
      return failure({ code: 'INVALID_CSV', rowNumber });
    }
    hasExtraCells ||= cells.length >= maxCells && cell.value.trim() !== '';
    if (cells.length < maxCells) {
      cells.push(cell.value);
    }
    position = cell.next;
    if (cell.end !== 'cell') {
      return success({ cells, hasExtraCells, next: position, isLast: cell.end === 'text' });
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
  const needsQuotes = [separator, QUOTE, CARRIAGE_RETURN, LINE_FEED].some((special) =>
    cell.includes(special),
  );
  return needsQuotes ? QUOTE + cell.replaceAll(QUOTE, ESCAPED_QUOTE) + QUOTE : cell;
}
