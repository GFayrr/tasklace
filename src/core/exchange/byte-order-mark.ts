const BYTE_ORDER_MARK = '﻿';

/** Removes a single byte order mark at the very start of an imported text, leaving any other one untouched. */
export function stripLeadingByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}
