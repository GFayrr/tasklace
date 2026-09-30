import { fillMessage, type Messages } from '../i18n/messages';
import { MINUTES_PER_HOUR, QUARTERS_PER_HOUR } from '../../core/time';

export interface DurationParts {
  readonly hours: number;
  readonly minutes: number;
}

const DECIMAL_PATTERN = /^(\d{1,9}(?:[.,]\d{1,4})?)\s*(h|d|min|m)?$/i;
const HOURS_AND_MINUTES_PATTERN = /^(\d{1,9})\s*h\s*(\d{1,2})\s*(?:min|m)?$/i;
const CLOCK_PATTERN = /^(\d{1,9}):(\d{2})$/;
const MAX_FIELD_LENGTH = 64;
const DAY_UNIT = 'd';
const MINUTE_UNITS: ReadonlySet<string> = new Set(['min', 'm']);

/** Splits a duration made of quarter hours into whole hours and minutes. */
export function durationParts(hours: number): DurationParts {
  const minutes = Math.round(hours * MINUTES_PER_HOUR);
  return { hours: Math.floor(minutes / MINUTES_PER_HOUR), minutes: minutes % MINUTES_PER_HOUR };
}

/** Writes a duration as the table shows it: "7 h", "1 h 15" or "45 min", numbers in the regional format. */
export function formatDuration(
  hours: number,
  messages: Messages,
  formatNumber: (value: number) => string,
): string {
  const parts = durationParts(hours);
  const values = { hours: formatNumber(parts.hours), minutes: String(parts.minutes) };
  if (parts.minutes === 0) {
    return fillMessage(messages.durations.hours, values);
  }
  return parts.hours === 0
    ? fillMessage(messages.durations.minutes, values)
    : fillMessage(messages.durations.hoursMinutes, values);
}

/** Writes a duration so that it reads back to the same value in the duration editor. */
export function durationEditorText(hours: number): string {
  const parts = durationParts(hours);
  if (parts.minutes === 0) {
    return `${String(parts.hours)} h`;
  }
  return parts.hours === 0
    ? `${String(parts.minutes)} min`
    : `${String(parts.hours)} h ${String(parts.minutes)}`;
}

/** Reads a duration written in hours ("14", "1,5", "1 h 30", "1:30"), minutes ("45 min") or working days ("2d"), rounded to the nearest quarter hour, or null when it is not one. */
export function parseDuration(text: string, dayHours: number): number | null {
  const trimmed = text.length > MAX_FIELD_LENGTH ? '' : text.trim();
  const hours = readHours(trimmed, dayHours);
  return hours === null || !Number.isFinite(hours)
    ? null
    : Math.round(hours * QUARTERS_PER_HOUR) / QUARTERS_PER_HOUR;
}

/** Reads the hours a duration text stands for, or null when it follows no known form. */
function readHours(text: string, dayHours: number): number | null {
  const both = HOURS_AND_MINUTES_PATTERN.exec(text) ?? CLOCK_PATTERN.exec(text);
  if (both !== null) {
    return Number(both[1]) + Number(both[2]) / MINUTES_PER_HOUR;
  }
  const decimal = DECIMAL_PATTERN.exec(text);
  if (decimal?.[1] === undefined) {
    return null;
  }
  const value = Number(decimal[1].replace(',', '.'));
  const unit = decimal[2]?.toLowerCase() ?? '';
  if (unit === DAY_UNIT) {
    return value * dayHours;
  }
  return MINUTE_UNITS.has(unit) ? value / MINUTES_PER_HOUR : value;
}
