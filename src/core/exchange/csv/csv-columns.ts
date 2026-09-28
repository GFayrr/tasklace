export type CsvColumn =
  'wbs' | 'name' | 'start' | 'end' | 'duration' | 'progress' | 'predecessors' | 'tag' | 'blocks';

export type HeaderReading =
  | { readonly kind: 'column'; readonly column: CsvColumn }
  | { readonly kind: 'unsupportedUnit'; readonly column: CsvColumn }
  | { readonly kind: 'unknown' };

export const CSV_COLUMN_ORDER: readonly CsvColumn[] = [
  'wbs',
  'name',
  'start',
  'end',
  'duration',
  'progress',
  'predecessors',
  'tag',
  'blocks',
];

export const CSV_HEADERS: Readonly<Record<CsvColumn, string>> = {
  wbs: 'WBS',
  name: 'Name',
  start: 'Start',
  end: 'End',
  duration: 'Duration (h)',
  progress: 'Progress (%)',
  predecessors: 'Predecessors',
  tag: 'Tag',
  blocks: 'Blocks',
};

const UNITS_BY_COLUMN: Readonly<Partial<Record<CsvColumn, readonly string[]>>> = {
  duration: ['h', 'hour', 'hours'],
  progress: ['%', 'percent'],
};
const HEADER_PATTERN = /^([^()]*?)\s*(?:\(([^()]*)\))?$/;
const MAX_HEADER_LENGTH = 64;

/** Recognizes the column a header names, ignoring case and surrounding spaces, and refuses a unit in brackets that a number column does not count in, a header too long to be one being left unread. */
export function readHeader(header: string): HeaderReading {
  const match = header.length > MAX_HEADER_LENGTH ? null : HEADER_PATTERN.exec(header.trim());
  const column = CSV_COLUMN_ORDER.find(
    (candidate) => normalize(CSV_HEADERS[candidate]) === normalize(match?.[1] ?? ''),
  );
  if (match === null || column === undefined) {
    return { kind: 'unknown' };
  }
  const units = UNITS_BY_COLUMN[column];
  const unit = match[2] === undefined ? null : match[2].trim().toLowerCase();
  const supported = units === undefined || unit === null || units.includes(unit);
  return supported ? { kind: 'column', column } : { kind: 'unsupportedUnit', column };
}

/** Reduces a header to its lower-case name without any unit in brackets. */
function normalize(header: string): string {
  const bracket = header.indexOf('(');
  return (bracket < 0 ? header : header.slice(0, bracket)).trim().toLowerCase();
}
