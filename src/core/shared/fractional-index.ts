import { MAX_SORT_KEY_LENGTH } from '../limits';
import { failure, success, type Result } from '../result';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const ZERO_DIGIT = DIGITS.charAt(0);
const MIDPOINT_DIVISOR = 2;
const KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export type SortKeyErrorCode = 'INVALID_SORT_KEY' | 'NO_SORT_KEY_BETWEEN';

/** Returns a sort key strictly between two keys, either of which may be missing, or explains why none fits. */
export function keyBetween(
  before: string | null,
  after: string | null,
): Result<string, SortKeyErrorCode> {
  if (!isUsableKey(before) || !isUsableKey(after)) {
    return failure('INVALID_SORT_KEY');
  }
  if (before !== null && after !== null && before >= after) {
    return failure('NO_SORT_KEY_BETWEEN');
  }
  const key = midpoint(before ?? '', after);
  return key.length > MAX_SORT_KEY_LENGTH ? failure('NO_SORT_KEY_BETWEEN') : success(key);
}

/** Returns a given number of short, evenly spaced and increasing sort keys, used to renumber siblings. */
export function spreadKeys(count: number): string[] {
  let width = 1;
  while (BASE ** width <= count + 1) {
    width += 1;
  }
  const step = Math.floor(BASE ** width / (count + 1));
  return Array.from({ length: count }, (_unused, index) =>
    stripTrailingZeros(toDigits((index + 1) * step, width)),
  );
}

/** Tells whether a key is missing or made of base 62 digits without a trailing zero. */
function isUsableKey(key: string | null): boolean {
  return key === null || KEY_PATTERN.test(key);
}

/** Builds the shortest key between a lower key, empty meaning zero, and a higher key, null meaning one. */
function midpoint(low: string, high: string | null): string {
  const prefixLength = high === null ? 0 : sharedPrefixLength(low, high);
  if (high !== null && prefixLength > 0) {
    const rest = midpoint(low.slice(prefixLength), high.slice(prefixLength));
    return high.slice(0, prefixLength) + rest;
  }
  const lowDigit = low === '' ? 0 : DIGITS.indexOf(low.charAt(0));
  const highDigit = high === null ? BASE : DIGITS.indexOf(high.charAt(0));
  if (highDigit - lowDigit > 1) {
    return DIGITS.charAt(Math.floor((lowDigit + highDigit) / MIDPOINT_DIVISOR));
  }
  if (high !== null && high.length > 1) {
    return high.charAt(0);
  }
  return DIGITS.charAt(lowDigit) + midpoint(low.slice(1), null);
}

/** Counts the leading digits two keys share, missing digits of the lower key counting as zeros. */
function sharedPrefixLength(low: string, high: string): number {
  let length = 0;
  while (length < high.length && (low.charAt(length) || ZERO_DIGIT) === high.charAt(length)) {
    length += 1;
  }
  return length;
}

/** Writes a whole number in base 62 with a fixed number of digits. */
function toDigits(value: number, width: number): string {
  let digits = '';
  let remaining = value;
  for (let position = 0; position < width; position += 1) {
    digits = DIGITS.charAt(remaining % BASE) + digits;
    remaining = Math.floor(remaining / BASE);
  }
  return digits;
}

/** Removes the trailing zero digits of a key, which do not change its place in the order. */
function stripTrailingZeros(key: string): string {
  let end = key.length;
  while (end > 1 && key.charAt(end - 1) === ZERO_DIGIT) {
    end -= 1;
  }
  return key.slice(0, end);
}
