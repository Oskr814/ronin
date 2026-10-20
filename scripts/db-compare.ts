// What the import scripts (db-import-*.ts) compare the database with the
// files by: the content, since jsonb keeps an object's keys in an order of
// its own.
const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value);

export const sameContent = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
