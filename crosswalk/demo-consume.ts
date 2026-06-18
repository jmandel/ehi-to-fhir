#!/usr/bin/env bun
/**
 * demo-consume.ts — proof that the crosswalk closes the coding gap.
 *
 * An EHI export ships Epic *local* codes (here: PROBLEM_LIST.DX_ID) but NOT the
 * standard codings (ICD-10 / SNOMED / ICD-9) the live FHIR API attaches to
 * Condition.code. This script shows a translation generator recovering those
 * codings purely by LEFT JOINing the crosswalk on the local code the EHI carries.
 *
 *   crosswalk row:  ehi_join_table=PROBLEM_LIST  ehi_join_column=DX_ID
 *                   epic_local_code=<DX_ID>  ->  target_system / target_code / target_display
 *   real EHI row :  PROBLEM_LIST.DX_ID = <DX_ID>
 *
 * Run:  bun run demo-consume.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseCsv } from "./merge.ts";

const DIR = import.meta.dir;
const DB_PATH = join(DIR, "..", "ehi.sqlite");
const AREA = "problem"; // demo area

// ---- 1. Load the crosswalk into a JOIN-able index keyed on (table, column, local code).
const rows = parseCsv(readFileSync(join(DIR, "ALL.csv"), "utf8"))
  .filter((r) => !(r.length === 1 && r[0] === ""));
const H = rows[0];
const col = (name: string) => H.indexOf(name);
const c = {
  area: col("area"), table: col("ehi_join_table"), column: col("ehi_join_column"),
  local: col("epic_local_code"), verified: col("ehi_verified"),
  fhirPath: col("fhir_path"), display: col("concept_display"),
  tSys: col("target_system"), tCode: col("target_code"), tDisp: col("target_display"),
};

type Coding = { system: string; code: string; display: string; path: string; concept: string };
const index = new Map<string, Coding[]>(); // key: TABLE|COLUMN|LOCALCODE  (verified rows only)
for (const r of rows.slice(1)) {
  if (r[c.area] !== AREA) continue;
  if ((r[c.verified] || "").toLowerCase() !== "yes") continue;
  const key = `${r[c.table]}|${r[c.column]}|${r[c.local]}`;
  (index.get(key) ?? index.set(key, []).get(key)!).push({
    system: r[c.tSys], code: r[c.tCode], display: r[c.tDisp],
    path: r[c.fhirPath], concept: r[c.display],
  });
}
console.log(`Loaded crosswalk: ${index.size} verified ${AREA} local codes -> standard codings\n`);

// ---- 2. Pull real EHI rows (the local codes an export actually ships).
if (!existsSync(DB_PATH)) {
  console.error(`No EHI db at ${DB_PATH}; cannot demo a live JOIN.`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
// DX_IDs that are present in this patient's PROBLEM_LIST *and* have a crosswalk hit.
const dxIds = db
  .query<{ DX_ID: string }, []>(
    `SELECT DISTINCT DX_ID FROM PROBLEM_LIST WHERE DX_ID IS NOT NULL AND DX_ID <> '' ORDER BY DX_ID`
  )
  .all()
  .map((r) => r.DX_ID)
  .filter((id) => index.has(`PROBLEM_LIST|DX_ID|${id}`));

// ---- 3. For 3-5 real DX_IDs, show the code.coding[] the generator would re-attach.
const examples = dxIds.slice(0, 5);
console.log(`Recovering Condition.code.coding[] for ${examples.length} real PROBLEM_LIST.DX_IDs:\n`);
for (const dxId of examples) {
  const desc = db
    .query<{ DESCRIPTION: string }, [string]>(
      `SELECT DESCRIPTION FROM PROBLEM_LIST WHERE DX_ID = ? AND DESCRIPTION IS NOT NULL AND DESCRIPTION <> '' LIMIT 1`
    )
    .get(dxId)?.DESCRIPTION;
  const codings = index.get(`PROBLEM_LIST|DX_ID|${dxId}`)!;
  console.log(`EHI: PROBLEM_LIST.DX_ID=${dxId}  "${desc ?? codings[0].concept}"`);
  console.log(`  -> Condition.code.coding[] (recovered, ${codings.length}):`);
  for (const cd of codings) {
    console.log(`       { system: "${cd.system}", code: "${cd.code}", display: "${cd.display}" }`);
  }
  console.log();
}
db.close();
console.log("Without the crosswalk these codings are dropped; with it they re-attach by JOIN on DX_ID.");
