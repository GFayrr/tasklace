import { formatDateTime, parseDate, parseDateTime } from '../../core/civil-format';
import { failure, success, type Result } from '../../core/result';
import type { DayIndex, ProjectHour } from '../../core/time';

export type TableDate =
  | { readonly kind: 'date'; readonly day: DayIndex }
  | { readonly kind: 'dateTime'; readonly hour: ProjectHour };

const SPACE_BEFORE_TIME = /^(\d{4}-\d{2}-\d{2}) (?=\d)/;

/** Writes an instant as the table shows it, "YYYY-MM-DD HH:MM", the same on every computer. */
export function formatTableDateTime(hour: ProjectHour): string {
  return formatDateTime(hour).replace('T', ' ');
}

/** Reads a date typed in the table, only in ISO form: "YYYY-MM-DD", optionally followed by a space or "T" and a quarter-hour time "HH:MM". */
export function parseTableDate(text: string): Result<TableDate, 'INVALID_DATE'> {
  const iso = text.trim().replace(SPACE_BEFORE_TIME, '$1T');
  const hour = parseDateTime(iso);
  if (hour.ok) {
    return success({ kind: 'dateTime', hour: hour.value });
  }
  const day = parseDate(iso);
  return day.ok ? success({ kind: 'date', day: day.value }) : failure('INVALID_DATE');
}

/** Tells whether the browser refused to show its calendar, as it does without a user gesture or where it has none, rather than failing for another reason. */
export function isPickerRefusal(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'NotSupportedError')
  );
}
