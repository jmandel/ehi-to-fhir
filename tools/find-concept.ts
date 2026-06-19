#!/usr/bin/env bun
/**
 * find-concept.ts — the "before you declare a datum ABSENT, search the WHOLE export" gate.
 *
 * The recurring root-cause bug: a generator checks the one obvious column on the one
 * obvious table, finds it blank/stripped, and concludes "not in the export" — when the
 * value actually lives in another table (CPT in SVC_LN_INFO, not the stripped ARPB column;
 * a dose in HV_DISCRETE_DOSE, not ORDER_MED.DOSAGE; …). This tool makes that search
 * exhaustive and cheap, across ALL tables, not just one domain.
 *
 *   bun tools/find-concept.ts "marital"            # schema search: column names + descriptions + table descs
 *   bun tools/find-concept.ts "CPT" --grep '\b\d{5}\b'   # + value scan: which raw TSVs contain the pattern
 *   bun tools/find-concept.ts --grep '997[0-9]{2}'        # value-only scan (e.g. a specific CPT family)
 *   bun tools/find-concept.ts --grep 'topiramate' --notes # ALSO scan the UNSTRUCTURED note corpus
 *
 * Schema search hits EVERY documented table (populated or not) and flags which are
 * populated. The optional --grep runs a fast literal/regex scan over raw/EHITables/*.tsv
 * (the actual values), reporting the tables that contain matches with a sample line.
 *
 * THE NOTE-CORPUS BLIND SPOT: the structured TSV scan above does NOT cover the free-text
 * clinical-note corpus (raw/Rich Text/*.RTF) or scanned media (raw/Media/). A datum can be
 * "0 hits in every TSV" yet be present verbatim as note narrative — e.g. the encounter
 * Patient-Instructions text ("...topiramate for headaches... For blood pressure:...") lives
 * in raw/Rich Text/HNO_3820384431_*.RTF, not in any table. Pass --notes (alone for a default
 * "find note text" scan, or alongside --grep to extend the value scan) to search the RTF note
 * bodies (extracted to plain text) and the Media index. Each RTF filename encodes its NOTE_ID
 * (HNO_<NOTE_ID>_<...>.RTF); matches are mapped back to HNO_INFO (note type + CSN).
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { readFileSync } from "fs";
import { rtfToText } from "../my-ehi/lib/rtf2txt.ts";

const DB = new Database(process.env.EHI_DB ?? resolve(import.meta.dir, "..", "ehi.sqlite"), { readonly: true });
DB.run("PRAGMA busy_timeout = 8000");

const args = process.argv.slice(2);
const gi = args.indexOf("--grep");
const grepPat = gi >= 0 ? args[gi + 1] : undefined;
const wantNotes = args.includes("--notes");
const term = args.filter((a, i) =>
  a !== "--notes" && i !== gi && (gi < 0 || i !== gi + 1))[0];

if (!term && !grepPat) {
  console.error('usage: bun tools/find-concept.ts "<term>" [--grep "<regex>"] [--notes]');
  process.exit(2);
}

// The pattern the note scan should look for: explicit --grep wins; otherwise fall back to the
// bare term so `--notes "topiramate"` works without a separate --grep.
const notePat = grepPat ?? term;

if (term) {
  console.log(`\n=== SCHEMA SEARCH for "${term}" (column name / column desc / table desc) ===`);
  const cols = DB.query(
    `SELECT c.table_name, c.column_name, substr(c.description,1,70) d,
            COALESCE(t.n_rows,-1) AS rows
     FROM _schema_column c LEFT JOIN _tables t ON t.table_name=c.table_name
     WHERE c.column_name LIKE '%'||?1||'%' OR c.description LIKE '%'||?1||'%'
     ORDER BY (t.n_rows IS NULL), CAST(COALESCE(t.n_rows,0) AS INTEGER) DESC
     LIMIT 60`
  ).all(term) as any[];
  const pop = cols.filter((c) => c.rows > 0);
  const empty = cols.filter((c) => c.rows <= 0);
  console.log(`-- POPULATED tables (${pop.length} cols) — THESE are where the datum could actually be --`);
  for (const c of pop) console.log(`  ${String(c.rows).padStart(5)}r  ${c.table_name}.${c.column_name}  — ${c.d ?? ""}`);
  if (empty.length) console.log(`-- documented but EMPTY/not-shipped (${empty.length} cols) — ${empty.slice(0, 12).map((c) => c.table_name + "." + c.column_name).join(", ")}${empty.length > 12 ? " …" : ""}`);
  const tabs = DB.query(
    `SELECT s.table_name, substr(s.description,1,80) d, COALESCE(t.n_rows,-1) rows
     FROM _schema_table s LEFT JOIN _tables t ON t.table_name=s.table_name
     WHERE s.description LIKE '%'||?1||'%' AND t.n_rows>0 LIMIT 20`
  ).all(term) as any[];
  if (tabs.length) { console.log(`-- populated tables whose DESCRIPTION matches --`); for (const t of tabs) console.log(`  ${String(t.rows).padStart(5)}r  ${t.table_name}  — ${t.d}`); }
}

if (grepPat) {
  console.log(`\n=== VALUE SCAN for /${grepPat}/ across raw/EHITables/*.tsv ===`);
  const rawDir = resolve(import.meta.dir, "..", "my-ehi", "raw", "EHITables");
  // grep -lE: list files containing the pattern; then one sample line each.
  const proc = Bun.spawnSync(["bash", "-lc", `grep -rlE ${JSON.stringify(grepPat)} ${JSON.stringify(rawDir)} 2>/dev/null | head -40`], { stdout: "pipe" });
  const files = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  if (!files.length) { console.log("  (no raw table contains this pattern)"); }
  for (const f of files) {
    const name = f.split("/").pop();
    const s = Bun.spawnSync(["bash", "-lc", `grep -mE 1 ${JSON.stringify(grepPat)} ${JSON.stringify(f)} | cut -c1-100`], { stdout: "pipe" });
    console.log(`  ${name}: ${new TextDecoder().decode(s.stdout).trim()}`);
  }
  console.log(`  (${files.length} table(s) contain matches)`);
}

if (wantNotes && notePat) {
  console.log(`\n=== NOTE-CORPUS SCAN for /${notePat}/ across raw/Rich Text/*.RTF + raw/Media/ ===`);
  let re: RegExp;
  try { re = new RegExp(notePat, "i"); }
  catch { re = new RegExp(notePat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } // literal fallback
  const rawRoot = resolve(import.meta.dir, "..", "my-ehi", "raw");

  // Map NOTE_ID → {type, csn} once, so RTF hits can be traced back to HNO_INFO.
  const hno = new Map<string, { type: string | null; csn: string | null }>();
  for (const r of DB.query(
    `SELECT NOTE_ID, NOTE_TYPE_NOADD_C_NAME t, PAT_ENC_CSN_ID csn FROM HNO_INFO`).all() as any[]) {
    hno.set(String(r.NOTE_ID), { type: r.t, csn: r.csn });
  }

  // --- raw/Rich Text/*.RTF: extract to plain text, then test the pattern. ---
  const rtfDir = resolve(rawRoot, "Rich Text");
  const glob = new Bun.Glob("*.RTF");
  let rtfHits = 0, rtfScanned = 0, rtfFellBack = 0;
  for (const name of [...glob.scanSync(rtfDir)].sort()) {
    rtfScanned++;
    const path = resolve(rtfDir, name);
    let rtf: string;
    try { rtf = readFileSync(path, "latin1"); } catch { continue; }
    let text: string;
    try {
      text = rtfToText(rtf);
      // rtf2txt fails (throws above) or yields nothing on some files → crude fallback.
      if (!text.trim()) { text = crudeStrip(rtf); rtfFellBack++; }
    } catch {
      text = crudeStrip(rtf); rtfFellBack++;
    }
    if (!re.test(text)) continue;
    rtfHits++;
    // Filename: HNO_<NOTE_ID>_<rest>.RTF → 2nd underscore-token is NOTE_ID.
    const noteId = name.split("_")[1] ?? "";
    const info = hno.get(noteId);
    const m = text.match(re);
    const sample = (m ? snippet(text, m.index ?? 0) : "").slice(0, 100);
    const tag = info ? `NOTE_ID=${noteId} type="${info.type ?? "?"}" CSN=${info.csn ?? "?"}`
                     : `NOTE_ID=${noteId} (no HNO_INFO row)`;
    console.log(`  ${name}: ${tag}\n      …${sample}…`);
  }
  console.log(`  (${rtfHits}/${rtfScanned} RTF note(s) match; ${rtfFellBack} used the crude fallback stripper)`);

  // --- raw/Media/: binaries (scans/PDFs) aren't grep-able as text; surface the index. ---
  const mediaIdx = resolve(rawRoot, "Media", "_INDEX.HTML");
  try {
    const idx = readFileSync(mediaIdx, "utf8");
    // Each media row: <a href=".\FILE">FILE</a></td><td>DESCRIPTION</td>
    const rows = [...idx.matchAll(/href="[^"]*?([^\\\/"]+)"[^>]*>[^<]*<\/a><\/td><td>([^<]*)</g)];
    const mediaHits = rows.filter(([, file, desc]) => re.test(file) || re.test(desc));
    if (mediaHits.length) {
      console.log(`  -- raw/Media/ index matches (binary files; description/filename only) --`);
      for (const [, file, desc] of mediaHits) console.log(`     ${file} — ${desc.trim()}`);
    }
    console.log(`  (${mediaHits.length}/${rows.length} media-index entr${rows.length === 1 ? "y" : "ies"} match by filename/description; blob contents are not text-searchable)`);
  } catch {
    console.log(`  (no raw/Media/_INDEX.HTML to scan)`);
  }
}

/**
 * Crude RTF→text fallback for files where rtf2txt throws or yields nothing: drop whole
 * skippable groups, strip control words/symbols, unescape \'xx hex, and unwrap braces.
 * Intentionally lossy — just enough for a value scan to find a phrase.
 */
function crudeStrip(rtf: string): string {
  return rtf
    .replace(/\{\\\*?\\(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|latentstyles|datastore|generator)[^{}]*\}/gi, " ")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(?:par|line|row|cell|tab|sect|page)\b/g, "\n")
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, " ")  // control words
    .replace(/\\[^a-zA-Z]/g, " ")          // control symbols
    .replace(/[{}]/g, " ")
    .replace(/[ \t]+/g, " ");
}

/** A short context window around a match index, single-lined. */
function snippet(text: string, at: number): string {
  return text.slice(Math.max(0, at - 20), at + 80).replace(/\s+/g, " ").trim();
}
