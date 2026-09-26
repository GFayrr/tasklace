export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Wraps a value in a successful result. */
export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps an error in a failed result. */
export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
