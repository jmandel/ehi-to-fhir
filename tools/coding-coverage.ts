#!/usr/bin/env bun
/**
 * coding-coverage.ts — measure standard-terminology coding coverage of generated
 * FHIR vs the reference target, WITH vs WITHOUT the answer-key layer.
 *
 *   bun tools/coding-coverage.ts            # summary + writes nothing
 *   bun tools/coding-coverage.ts --json     # machine-readable JSON to stdout
 *
 * Method
 * ------
 * The EHI export does NOT carry standard codings (LOINC/SNOMED/ICD/RxNorm/CVX/CPT);
 * the reference FHIR (fhir-target/) does. For each resource TYPE we collect the set
 * of DISTINCT standard (system,code) pairs that appear anywhere in the target's
 * resources, then ask: how many of those exact pairs appear anywhere in our
 *   (a) baseline  output (out/)
 *   (b) enriched output (out-answerkey/, answer-key layered on)
 * A pair is "covered" if the same {system,code} is emitted ANYWHERE in our output
 * for that type (we compare by value, since ids are Epic-opaque and won't line up).
 *
 * We restrict to the recoverable STANDARD systems — the ones the answer key targets —
 * because Epic-local urn:oid:* category/flowsheet systems are passthroughs, not the
 * coding gap under study. Counts are deduped distinct pairs (a missing LOINC that
 * recurs on 50 resources is one gap, not 50).
 */
import { resolve } from "path";
import { readdirSync, existsSync, readFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const TARGET = resolve(ROOT, "fhir-target");
const BASE = resolve(ROOT, "out");
const AK = resolve(ROOT, "out-answerkey");

// The recoverable standard terminologies the answer key targets. Anything else
// (Epic urn:oid category/flowsheet systems, hl7 structural code systems) is out of
// scope for the coding gap and excluded from the denominator.
const STD: Record<string, string> = {
  "http://loinc.org": "LOINC",
  "http://snomed.info/sct": "SNOMED",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10-CM",
  "http://hl7.org/fhir/sid/icd-9-cm": "ICD-9-CM",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RxNorm",
  "http://hl7.org/fhir/sid/cvx": "CVX",
  "urn:oid:2.16.840.1.113883.12.292": "CVX", // alt CVX oid (if present)
  "http://www.ama-assn.org/go/cpt": "CPT",
  "urn:oid:2.16.840.1.113883.6.12": "CPT",   // CPT-4 by oid
  "urn:oid:2.16.840.1.113883.3.26.1.5": "NDF-RT", // FDA/NCI allergen ontology (AllergyIntolerance.code)
};

function load(dir: string, type: string): any[] {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f === `${type}.json` || f.startsWith(`${type}__`))
    : [];
  const out: any[] = [];
  for (const f of files) {
    try { out.push(...JSON.parse(readFileSync(resolve(dir, f), "utf8"))); } catch {}
  }
  return out;
}

/** Collect distinct "system||code" pairs restricted to STD systems, anywhere in the array. */
function stdPairs(resources: any[]): Set<string> {
  const set = new Set<string>();
  const walk = (n: any) => {
    if (Array.isArray(n)) { for (const v of n) walk(v); return; }
    if (n && typeof n === "object") {
      if (typeof n.system === "string" && n.code !== undefined && STD[n.system]) {
        set.add(n.system + "||" + n.code);
      }
      for (const v of Object.values(n)) walk(v);
    }
  };
  for (const r of resources) walk(r);
  return set;
}

/** Collect ALL distinct "system||code" pairs (any system), anywhere in the array. */
function allPairs(resources: any[]): Set<string> {
  const set = new Set<string>();
  const walk = (n: any) => {
    if (Array.isArray(n)) { for (const v of n) walk(v); return; }
    if (n && typeof n === "object") {
      if (typeof n.system === "string" && n.code !== undefined) {
        set.add(n.system + "||" + n.code);
      }
      for (const v of Object.values(n)) walk(v);
    }
  };
  for (const r of resources) walk(r);
  return set;
}

const types = readdirSync(TARGET)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort();

// Per-system tallies: system -> {target, base, ak} as sets of "type||system||code"
type Tally = { target: Set<string>; base: Set<string>; ak: Set<string> };
const perSystem = new Map<string, Tally>();
const ensure = (label: string): Tally => {
  let t = perSystem.get(label);
  if (!t) { t = { target: new Set(), base: new Set(), ak: new Set() }; perSystem.set(label, t); }
  return t;
};

type RowT = { type: string; target: number; base: number; ak: number };
const perType: RowT[] = [];

for (const type of types) {
  const tgt = stdPairs(load(TARGET, type));
  const base = stdPairs(load(BASE, type));
  const ak = stdPairs(load(AK, type));

  let tCount = 0, bCount = 0, aCount = 0;
  for (const pair of tgt) {
    tCount++;
    const [sys] = pair.split("||");
    const label = STD[sys];
    const T = ensure(label);
    const tagged = type + "||" + pair;
    T.target.add(tagged);
    if (base.has(pair)) { bCount++; T.base.add(tagged); }
    if (ak.has(pair))   { aCount++; T.ak.add(tagged); }
  }
  if (tCount > 0) perType.push({ type, target: tCount, base: bCount, ak: aCount });
}

// Overall
let oT = 0, oB = 0, oA = 0;
const systemRows = [...perSystem.entries()]
  .map(([label, t]) => ({
    label,
    target: t.target.size,
    base: t.base.size,
    ak: t.ak.size,
  }))
  .sort((a, b) => b.target - a.target);
for (const r of systemRows) { oT += r.target; oB += r.base; oA += r.ak; }

if (process.argv.includes("--json")) {
  const xbc = parseCrosswalkByClass();
  const tA = allPairs(loadAllDir(TARGET)), bA = allPairs(loadAllDir(BASE)), aA = allPairs(loadAllDir(AK));
  const byClass = [...xbc.entries()].map(([cls, pairs]) => {
    let inTgt = 0, inBase = 0, inAk = 0;
    for (const pr of pairs) { if (tA.has(pr)) inTgt++; if (bA.has(pr)) inBase++; if (aA.has(pr)) inAk++; }
    return { class: cls, xwalk: pairs.size, inTarget: inTgt, base: inBase, ak: inAk };
  });
  console.log(JSON.stringify({
    overall: { target: oT, base: oB, ak: oA },
    perSystem: systemRows,
    perType,
    byClass,
  }, null, 2));
  process.exit(0);
}

const p = (n: number, d: number) => (d ? Math.round((100 * n) / d) + "%" : "-");
const gapClosed = (b: number, a: number, t: number) => {
  const gap = t - b;
  return gap === 0 ? "-" : Math.round((100 * (a - b)) / gap) + "%";
};

console.log("=== Standard-terminology coding coverage: target vs baseline vs answer-key ===\n");
console.log(
  "SYSTEM".padEnd(14),
  "TGT".padStart(5),
  "BASE".padStart(6),
  "BASE%".padStart(7),
  "AK".padStart(6),
  "AK%".padStart(6),
  "DELTA".padStart(7),
  "GAP-CLOSED".padStart(11),
);
console.log("-".repeat(72));
for (const r of systemRows) {
  console.log(
    r.label.padEnd(14),
    String(r.target).padStart(5),
    String(r.base).padStart(6),
    p(r.base, r.target).padStart(7),
    String(r.ak).padStart(6),
    p(r.ak, r.target).padStart(6),
    ("+" + (r.ak - r.base)).padStart(7),
    gapClosed(r.base, r.ak, r.target).padStart(11),
  );
}
console.log("-".repeat(72));
console.log(
  "OVERALL".padEnd(14),
  String(oT).padStart(5),
  String(oB).padStart(6),
  p(oB, oT).padStart(7),
  String(oA).padStart(6),
  p(oA, oT).padStart(6),
  ("+" + (oA - oB)).padStart(7),
  gapClosed(oB, oA, oT).padStart(11),
);

console.log("\n--- by resource type (distinct standard (system,code) pairs) ---");
console.log("TYPE".padEnd(22), "TGT".padStart(5), "BASE".padStart(6), "AK".padStart(6), "DELTA".padStart(7));
console.log("-".repeat(50));
for (const r of perType.sort((a, b) => b.target - a.target)) {
  console.log(
    r.type.padEnd(22),
    String(r.target).padStart(5),
    String(r.base).padStart(6),
    String(r.ak).padStart(6),
    ("+" + (r.ak - r.base)).padStart(7),
  );
}

// ============================================================================
// BY-CLASS breakdown (TODO #3): now that crosswalk/ALL.csv tags every row with
// system_class (standard | epic-instance-oid), measure coverage of the EXACT
// (target_system, target_code) pairs the crosswalk ASSERTS for each class —
// regardless of whether the target_system is a "standard" terminology. This is
// the honest denominator for the answer key: every pair here is anchored to a
// real EHI local code and tagged answer-key-sourced. A pair is "covered" if that
// {system,code} appears ANYWHERE in the corresponding output (deduped distinct).
// ============================================================================
function loadAllDir(dir: string): any[] {
  const out: any[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "bundle.json") continue;
    try { const a = JSON.parse(readFileSync(resolve(dir, f), "utf8")); if (Array.isArray(a)) out.push(...a); } catch {}
  }
  return out;
}

// Parse crosswalk/ALL.csv -> per-class set of distinct target "system||code" pairs.
function parseCrosswalkByClass(): Map<string, Set<string>> {
  const byClass = new Map<string, Set<string>>();
  const csvPath = resolve(ROOT, "crosswalk/ALL.csv");
  if (!existsSync(csvPath)) return byClass;
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return byClass;
  // minimal CSV split that respects double-quoted fields
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ""; } else cur += ch; }
    }
    out.push(cur); return out;
  };
  const header = split(lines[0]);
  const iSys = header.indexOf("target_system");
  const iCode = header.indexOf("target_code");
  const iClass = header.indexOf("system_class");
  if (iSys < 0 || iCode < 0 || iClass < 0) return byClass;
  for (let i = 1; i < lines.length; i++) {
    const row = split(lines[i]);
    const sys = (row[iSys] ?? "").trim();
    const code = (row[iCode] ?? "").trim();
    const cls = (row[iClass] ?? "").trim() || "unclassified";
    if (!sys || !code) continue;
    let s = byClass.get(cls); if (!s) { s = new Set(); byClass.set(cls, s); }
    s.add(sys + "||" + code);
  }
  return byClass;
}

const xwalkByClass = parseCrosswalkByClass();
if (xwalkByClass.size) {
  const tgtAll = allPairs(loadAllDir(TARGET));
  const baseAll = allPairs(loadAllDir(BASE));
  const akAll = allPairs(loadAllDir(AK));

  console.log("\n=== BY CLASS: crosswalk-asserted (target_system,target_code) pairs ===");
  console.log("(denominator = distinct tagged pairs the crosswalk anchors for that class)\n");
  console.log(
    "CLASS".padEnd(20),
    "XWALK".padStart(6),
    "INTGT".padStart(6),
    "BASE".padStart(6),
    "AK".padStart(6),
    "AK%".padStart(6),
    "DELTA".padStart(7),
  );
  console.log("-".repeat(64));
  let cT = 0, cI = 0, cB = 0, cA = 0;
  const order = ["standard", "epic-instance-oid"];
  const classes = [...xwalkByClass.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const cls of classes) {
    const pairs = xwalkByClass.get(cls)!;
    let inTgt = 0, inBase = 0, inAk = 0;
    for (const p of pairs) {
      if (tgtAll.has(p)) inTgt++;
      if (baseAll.has(p)) inBase++;
      if (akAll.has(p)) inAk++;
    }
    cT += pairs.size; cI += inTgt; cB += inBase; cA += inAk;
    console.log(
      cls.padEnd(20),
      String(pairs.size).padStart(6),
      String(inTgt).padStart(6),
      String(inBase).padStart(6),
      String(inAk).padStart(6),
      p(inAk, pairs.size).padStart(6),
      ("+" + (inAk - inBase)).padStart(7),
    );
  }
  console.log("-".repeat(64));
  console.log(
    "OVERALL".padEnd(20),
    String(cT).padStart(6),
    String(cI).padStart(6),
    String(cB).padStart(6),
    String(cA).padStart(6),
    p(cA, cT).padStart(6),
    ("+" + (cA - cB)).padStart(7),
  );
  console.log("\nlegend: XWALK=distinct tagged pairs in crosswalk; INTGT=present in reference target;");
  console.log("BASE/AK=present anywhere in baseline / answer-key output; AK%=AK/XWALK.");
}
