// Lightweight, dependency-free Result<T, E> discriminated union.
// Expected failures are returned as values; nothing in Snap throws.
//
// `attempt` and `attemptAsync` are the ONLY places in the codebase that catch.
// They quarantine the exceptions raised by Node built-ins (node:fs, JSON.parse)
// so that every other module is both throw-free and catch-free.

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Run a synchronous function that may throw, mapping any thrown value to a
 * domain error. Use this at the boundary with throwing Node built-ins.
 */
export function attempt<T, E>(fn: () => T, onThrow: (thrown: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (thrown) {
    return err(onThrow(thrown));
  }
}

/**
 * Run an asynchronous function that may throw or reject, mapping the failure to
 * a domain error. The returned promise always resolves — never rejects — so
 * async failures travel as values just like synchronous ones.
 */
export async function attemptAsync<T, E>(
  fn: () => Promise<T>,
  onThrow: (thrown: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    return err(onThrow(thrown));
  }
}
