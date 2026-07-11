// drizzle's .returning() types as T[] (correctly — nothing stops an UPDATE
// matching zero rows). For single-row INSERTs, a failed constraint throws
// before we'd ever see an empty array, so an empty result here means a bug,
// not a valid outcome — this turns Drizzle's honest T[] into the T our
// callers actually need instead of every call site re-litigating "what if
// it's empty" for a case that can't happen.
export function firstOrThrow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected to insert/find a ${what}, got none`);
  return row;
}
