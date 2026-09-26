/** Compares two strings by code unit, independently of the user's locale. */
export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
