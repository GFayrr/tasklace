/** Returns the value at a position of a table the program built, throwing when the position is outside it, which can only mean a broken invariant and must never turn silently into a wrong number. */
export function valueAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(
      `No value at position ${String(index)} of a table of ${String(values.length)}.`,
    );
  }
  return value;
}
