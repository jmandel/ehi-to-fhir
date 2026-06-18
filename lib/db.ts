/**
 * db.ts — shared read-only handle on the EHI SQLite specimen, plus the helpers
 * every domain generator needs. Import this; never open the DB yourself.
 *
 * DB path: $EHI_DB or ./ehi.sqlite (relative to the ehi-fhir/ project root).
 * Everything in the EHI export is stored as TEXT — CAST before you order/aggregate.
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";

const DB_PATH = process.env.EHI_DB ?? resolve(import.meta.dir, "..", "ehi.sqlite");
export const db = new Database(DB_PATH, { readonly: true });
db.run("PRAGMA busy_timeout = 8000");

/** Run a SQL query, return rows as plain objects. */
export function q<T = Record<string, any>>(sql: string, ...params: any[]): T[] {
  return db.query(sql).all(...params) as T[];
}

/** Run a SQL query, return the first row or undefined. */
export function q1<T = Record<string, any>>(sql: string, ...params: any[]): T | undefined {
  return db.query(sql).get(...params) as T | undefined;
}

/** True if a table exists and has rows. */
export function tableHasRows(table: string): boolean {
  const row = q1<{ n_rows: number }>(`SELECT n_rows FROM _tables WHERE table_name = ?`, table);
  return !!row && Number(row.n_rows) > 0;
}

/** Column names actually materialized in a table (NOT the schema doc's aspirational set). */
export function columnsOf(table: string): string[] {
  return q<{ name: string }>(`PRAGMA table_info('${table}')`).map((r) => r.name);
}

/**
 * Epic *_DATE_REAL → ISO date (YYYY-MM-DD).
 * DATE_REAL is days since 1840-12-31 (the integer part); fractional part is intraday.
 * Returns undefined for null/empty/sentinel input.
 */
export function dateRealToISO(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!isFinite(n)) return undefined;
  const epoch = Date.UTC(1840, 11, 31); // 1840-12-31
  const ms = epoch + Math.floor(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse Epic textual datetimes that appear in the TSVs, e.g.
 *   "8/14/2023 12:00:00 AM"  or  "2023-08-14"  → returns ISO or undefined.
 * Best-effort: returns the input unchanged if it already looks ISO.
 */
export function parseEpicDateTime(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s; // already ISO-ish
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) return undefined;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  let H = hh ? parseInt(hh) : 0;
  if (ap) {
    if (/PM/i.test(ap) && H < 12) H += 12;
    if (/AM/i.test(ap) && H === 12) H = 0;
  }
  const date = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  if (hh === undefined) return date;
  return `${date}T${String(H).padStart(2, "0")}:${(mm ?? "00").padStart(2, "0")}:${(ss ?? "00").padStart(2, "0")}`;
}
