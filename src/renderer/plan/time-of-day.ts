import { HOURS_PER_DAY, QUARTER_HOUR } from '../../core/time';

const TIME_PATTERN = /^(\d{2}):([0-5]\d)$/;
const MINUTES_PER_HOUR = 60;
const TWO_DIGITS = 2;

/** Writes a time of day as "HH:MM", the end of the day being written as midnight, as a time field shows it. */
export function formatTimeOfDay(hours: number): string {
  const minutes = Math.round((hours % HOURS_PER_DAY) * MINUTES_PER_HOUR);
  const hour = String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(TWO_DIGITS, '0');
  return `${hour}:${String(minutes % MINUTES_PER_HOUR).padStart(TWO_DIGITS, '0')}`;
}

/** Reads a time of day written as "HH:MM" on a quarter hour, as hours from midnight, or null when it cannot be read. */
export function parseTimeOfDay(text: string): number | null {
  const match = TIME_PATTERN.exec(text.trim());
  const hours =
    Number(match?.[1] ?? Number.NaN) + Number(match?.[2] ?? Number.NaN) / MINUTES_PER_HOUR;
  const onQuarter = Number.isInteger(hours / QUARTER_HOUR);
  return onQuarter && hours >= 0 && hours < HOURS_PER_DAY ? hours : null;
}
