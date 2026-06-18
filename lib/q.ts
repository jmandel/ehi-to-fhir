#!/usr/bin/env bun
/**
 * q.ts — read-only SQL helper for the EHI specimen (ehi-fhir project copy).
 *   bun lib/q.ts "SELECT * FROM PAT_ENC LIMIT 3"     # JSON rows
 *   bun lib/q.ts --table "SELECT ..."                # aligned table
 * DB path: $EHI_DB or ./ehi.sqlite.
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";
const args = process.argv.slice(2);
const asTable = args[0] === "--table";
const sql = (asTable ? args.slice(1) : args).join(" ");
if (!sql.trim()) { console.error('usage: bun lib/q.ts "<SQL>"'); process.exit(1); }
const DB_PATH = process.env.EHI_DB ?? resolve(import.meta.dir, "..", "ehi.sqlite");
const db = new Database(DB_PATH, { readonly: true });
db.run("PRAGMA busy_timeout = 8000");
const rows = db.query(sql).all() as Record<string, unknown>[];
if (!asTable) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
if (rows.length === 0) { console.log("(0 rows)"); process.exit(0); }
const cols = Object.keys(rows[0]);
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
const line = (cells: string[]) => cells.map((s, i) => s.padEnd(w[i])).join("  ");
console.log(line(cols));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
console.log(`(${rows.length} rows)`);
