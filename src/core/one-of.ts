/** Tells whether a value is one of a list of choices, which then gives the value their type. */
export function isOneOf<T>(choices: readonly T[], value: unknown): value is T {
  return choices.some((choice) => choice === value);
}
