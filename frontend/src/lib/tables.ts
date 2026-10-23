/** Showing rows of JSON as a table. */

/** Every field name of `rows`, in the order they first appear (rows newest first). */
export function tableColumns(rows: { data: Record<string, unknown> }[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.data)) columns.add(key);
  return [...columns];
}

/** A cell's text: text as it is, other values as compact JSON; null for a missing field. */
export function cellText(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
