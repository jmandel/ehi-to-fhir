#!/usr/bin/env bun
/**
 * propose.ts — PROPOSE-MODE divergence survey (observation only; permits nothing).
 *
 * Aligns out/ resources to fhir-target/ by NATURAL KEY (not FHIR id) per resource type,
 * then for every element of a matched target resource that is NOT byte-identical to ours,
 * records the delta and a FIRST-GUESS kind:
 *
 *   isomorphic-ref    — a Reference whose target id differs but resolves to the SAME entity
 *                        (same natural key on both sides; only the synthetic id differs)
 *   specificity-ref   — a Reference whose referent is the same-or-NARROWER real entity,
 *                        verifiable by a parent/child join in the EHI org/location tree
 *   cosmetic-display   — a display/text string equal after normalization (case/space/nickname)
 *   structural-variant — same datum expressed in another valid FHIR shape
 *   coding-gap         — a missing/added standard coding (LOINC/SNOMED/RxNorm/ICD/CVX/CPT);
 *                        stays in its OWN bucket, tolerated-as-known, never "match"
 *   real-gap           — a value we are missing or that genuinely differs (regression-shaped)
 *   unsure             — couldn't confidently bucket; needs human eyes
 *
 * This is a SURVEY: it writes compare/DELTAS.md and prints clusters by resourceType.path
 * with counts + one concrete example each. It does NOT consult or write any tolerance
 * registry — classification here is a heuristic FIRST GUESS, not an approval.
 *
 *   bun compare/propose.ts            # full survey -> compare/DELTAS.md + stdout clusters
 *   bun compare/propose.ts Encounter  # restrict to one type (debug)
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const TARGET_DIR = resolve(ROOT, "fhir-target");
const OUT_DIR = resolve(ROOT, "out");

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
function load(dir: string, type: string): any[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f === `${type}.json` || f.startsWith(`${type}__`));
  const out: any[] = [];
  for (const f of files) {
    try {
      const a = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      if (Array.isArray(a)) out.push(...a);
    } catch {}
  }
  return out;
}

// load EVERY resource on each side (for ref-resolution natural keys)
function loadAll(dir: string): any[] {
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "bundle.json") continue;
    try {
      const a = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      if (Array.isArray(a)) out.push(...a);
    } catch {}
  }
  return out;
}

const targetTypes = readdirSync(TARGET_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort();

// ---------------------------------------------------------------------------
// id -> natural key, so a Reference can be compared by *what it points at*
// ---------------------------------------------------------------------------
const norm = (s: any) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// Build, for each side, fhirId -> { type, natKey, name }.
// natKey identifies the real-world entity independent of synthetic id.
function indexEntities(all: any[]): Map<string, { type: string; key: string; name: string }> {
  const m = new Map<string, { type: string; key: string; name: string }>();
  for (const r of all) {
    if (!r?.resourceType || !r?.id) continue;
    const t = r.resourceType;
    let key = "";
    // prefer the Epic-stable identifier value (shared on both sides for many types)
    const idents = (r.identifier || []).map((i: any) => norm(i.value)).filter(Boolean);
    if (t === "Practitioner") {
      // SER provider numeric id appears as an identifier value on both sides
      key = idents.find((v: string) => /^\d{4,7}$/.test(v)) || idents[0] || "";
    } else if (t === "Location" || t === "Organization") {
      key = norm(r.name); // names align (modulo casing) across sides
    } else if (t === "Patient") {
      key = "patient"; // singleton
    } else if (idents.length) {
      key = idents.join("|");
    }
    const name = r.name?.[0]?.text || (typeof r.name === "string" ? r.name : r.name?.[0]?.family) || r.name || "";
    m.set(`${t}/${r.id}`, { type: t, key, name: String(name) });
  }
  return m;
}

const TARGET_ALL = loadAll(TARGET_DIR);
const OUT_ALL = loadAll(OUT_DIR);
const TGT_ENT = indexEntities(TARGET_ALL);
const OUR_ENT = indexEntities(OUT_ALL);

// ---------------------------------------------------------------------------
// EHI org/location tree — for specificity-ref verification (parent/child join)
// We climb from a Location/Organization to its parent(s) using DB master files.
// ---------------------------------------------------------------------------
let tree: { childToParents: Map<string, Set<string>>; allNames: Set<string> } | null = null;
function loadTree() {
  if (tree) return tree;
  const childToParents = new Map<string, Set<string>>();
  const allNames = new Set<string>();
  try {
    const { db } = require(resolve(ROOT, "lib/db"));
    const add = (child: string, parent: string) => {
      const c = norm(child), p = norm(parent);
      if (!c || !p) return;
      (childToParents.get(c) ?? childToParents.set(c, new Set()).get(c)!).add(p);
      allNames.add(c); allNames.add(p);
    };
    // department -> revenue location -> service area -> facility, and POS grouper -> brand
    const tries = [
      `SELECT DEPARTMENT_NAME child, REV_LOC_NAME parent FROM CLARITY_DEP WHERE REV_LOC_NAME IS NOT NULL`,
      `SELECT RECORD_NAME child, SERV_AREA_NAME parent FROM CLARITY_SA WHERE SERV_AREA_NAME IS NOT NULL`,
    ];
    for (const sql of tries) {
      try { for (const row of db.prepare(sql).all() as any[]) add(row.child, row.parent); } catch {}
    }
  } catch {}
  tree = { childToParents, allNames };
  return tree;
}
// is `narrow` a same-or-descendant of `broad` in the tree (or equal)?
function isSameOrNarrower(narrow: string, broad: string): boolean {
  const a = norm(narrow), b = norm(broad);
  if (!a || !b) return false;
  if (a === b) return true;
  const { childToParents } = loadTree();
  const seen = new Set<string>();
  let frontier = [a];
  while (frontier.length) {
    const next: string[] = [];
    for (const n of frontier) {
      if (seen.has(n)) continue;
      seen.add(n);
      const parents = childToParents.get(n);
      if (!parents) continue;
      if (parents.has(b)) return true;
      next.push(...parents);
    }
    frontier = next;
  }
  return false;
}

// ---------------------------------------------------------------------------
// natural-key resolver per type (target<->our alignment)
// ---------------------------------------------------------------------------
const norm2 = norm;
function effective(r: any): string {
  return r.effectiveDateTime || r.effectivePeriod?.start || r.onsetDateTime || r.onsetPeriod?.start ||
    r.authoredOn || r.recordedDate || r.period?.start || r.date || r.created || "";
}
function loincOf(r: any): string {
  return ((r.code?.coding || []).filter((c: any) => /loinc/.test(c.system || "")).map((c: any) => c.code).sort().join(",")) || "";
}
function naturalKeys(type: string, r: any): string[] {
  const idents = (r.identifier || []).map((i: any) => norm2(i.value)).filter(Boolean);
  switch (type) {
    case "Patient":
    case "CareTeam":
    case "Goal":
    case "Coverage":
      return ["singleton"]; // these are 1 (or matched positionally below)
    case "Practitioner": {
      const ser = idents.find((v: string) => /^\d{4,7}$/.test(v));
      return ser ? [ser] : idents;
    }
    case "Location":
    case "Organization":
      return [norm2(r.name)];
    case "Condition":
      return [norm2(r.code?.text) + "@" + (effective(r) || "")];
    case "AllergyIntolerance":
      return [norm2(r.code?.text || r.code?.coding?.[0]?.display)];
    case "Observation": {
      const l = loincOf(r);
      const k = (l || norm2(r.code?.text || r.code?.coding?.[0]?.display)) + "@" + effective(r);
      return [k];
    }
    case "CarePlan":
      return [norm2(r.category?.[0]?.coding?.[0]?.code || r.category?.[0]?.text) + "@" + effective(r)];
    default:
      // identifier-keyed types: Encounter, Immunization, MedicationRequest, Medication,
      // DiagnosticReport, Specimen, DocumentReference
      return idents.length ? idents : [norm2(r.code?.text)];
  }
}

// greedy 1:1 alignment by shared natural key (any candidate key overlap)
function align(type: string, tgt: any[], our: any[]): { pairs: [any, any][]; tgtOnly: any[]; ourOnly: any[] } {
  // singletons: positional pairing
  const ourByKey = new Map<string, any[]>();
  for (const o of our) for (const k of naturalKeys(type, o)) (ourByKey.get(k) ?? ourByKey.set(k, []).get(k)!).push(o);
  const pairs: [any, any][] = [];
  const usedOur = new Set<any>();
  const tgtOnly: any[] = [];
  for (const t of tgt) {
    let matched: any = null;
    for (const k of naturalKeys(type, t)) {
      const cands = ourByKey.get(k);
      if (cands) { const c = cands.find((x) => !usedOur.has(x)); if (c) { matched = c; break; } }
    }
    if (matched) { pairs.push([t, matched]); usedOur.add(matched); }
    else tgtOnly.push(t);
  }
  const ourOnly = our.filter((o) => !usedOur.has(o));
  return { pairs, tgtOnly, ourOnly };
}

// ---------------------------------------------------------------------------
// deep diff: flatten to dotted paths (array idx -> []), compare leaf values
// ---------------------------------------------------------------------------
type Leaf = { path: string; value: any };
function flatten(node: any, prefix: string, acc: Map<string, any>) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((it) => flatten(it, prefix + "[]", acc)); return; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, acc);
    return;
  }
  // leaf: collect multiset of scalar values at this path
  const cur = acc.get(prefix);
  if (cur === undefined) acc.set(prefix, [node]);
  else cur.push(node);
}
function flat(r: any): Map<string, any[]> {
  const m = new Map<string, any[]>();
  flatten(r, "", m);
  return m;
}

const STANDARD_SYS = /(loinc|snomed|rxnorm|fhir\/sid|cvx|hl7\.org\/fhir\/sid|ndc|ama-assn|cpt|icd)/i;

// ---------------------------------------------------------------------------
// classify a single path delta between a matched (target, our) pair
// ---------------------------------------------------------------------------
type Delta = {
  rt: string; path: string;
  kind: string;
  tgt: any; our: any;
  note: string;
};

function isRefPath(path: string): boolean {
  return /\.reference$/.test(path) || path === "reference";
}
function refParent(path: string): string { return path.replace(/\.reference$/, ""); }

// resolve a "Type/id" reference to its natural key using the side's entity index
function refKey(ref: string, side: Map<string, any>): { type: string; key: string; name: string } | null {
  if (typeof ref !== "string") return null;
  return side.get(ref) || null;
}

// does the sibling .reference at the same node resolve to the SAME natural-key entity?
// proves a divergent .display still labels the same real-world thing.
function siblingRefSameEntity(path: string, tf: Map<string, any[]>, of: Map<string, any[]>): { same: boolean; tgtName: string; ourName: string } | null {
  if (!/\.display$/.test(path)) return null;
  const refPath = path.replace(/\.display$/, ".reference");
  const tref = tf.get(refPath)?.[0], oref = of.get(refPath)?.[0];
  if (typeof tref !== "string" || typeof oref !== "string") return null;
  const tk = refKey(tref, TGT_ENT), ok = refKey(oref, OUR_ENT);
  if (!tk || !ok) return null;
  return { same: !!(tk.key && ok.key && tk.key === ok.key), tgtName: tk.name, ourName: ok.name };
}

function classifyValue(rt: string, path: string, tgtVal: any, ourVal: any, tf: Map<string, any[]>, of: Map<string, any[]>): { kind: string; note: string } {
  // ---- reference value ----
  if (isRefPath(path)) {
    const tk = refKey(String(tgtVal), TGT_ENT);
    const ok = refKey(String(ourVal), OUR_ENT);
    if (tk && ok) {
      if (tk.key && ok.key && tk.key === ok.key) return { kind: "isomorphic-ref", note: `same natural key "${tk.key}"` };
      // specificity: our referent same-or-narrower than target in the tree
      if (tk.name && ok.name && isSameOrNarrower(ok.name, tk.name))
        return { kind: "specificity-ref", note: `our "${ok.name}" is same/narrower than target "${tk.name}" in EHI tree` };
      // names look like a brand/department pair but not joinable -> unsure (candidate blessed)
      if (tk.name && ok.name && norm(tk.name) !== norm(ok.name))
        return { kind: "unsure", note: `ref to different entity: target "${tk.name}" vs our "${ok.name}" (no tree join)` };
      return { kind: "unsure", note: `ref differs: target ${tgtVal} our ${ourVal}` };
    }
    return { kind: "real-gap", note: `unresolvable ref (tgt ${tk ? "ok" : "?"}, our ${ok ? "ok" : "?"})` };
  }

  // ---- display / text strings ----
  if (/\.display$/.test(path) || /\.text$/.test(path) || path === "display" || path === "text") {
    if (norm(tgtVal) === norm(ourVal)) return { kind: "cosmetic-display", note: "equal after normalize (case/space)" };
    // nickname / abbreviation containment (Josh vs Joshua, "Jess Y" vs full name)
    const a = norm(tgtVal), b = norm(ourVal);
    if (a && b && (a.includes(b) || b.includes(a))) return { kind: "cosmetic-display", note: `containment: "${tgtVal}" ~ "${ourVal}"` };
    // ENTITY-CONFIRMED display divergence: sibling .reference proves the same entity, so the
    // differing label (privacy-masked "Jess Y" vs our "YOUNG, JESS") is cosmetic, not a wrong ref.
    const sib = siblingRefSameEntity(path, tf, of);
    if (sib?.same) return { kind: "cosmetic-display", note: `same entity (ref natural-key matches); label differs "${tgtVal}" vs "${ourVal}"` };
    return { kind: "unsure", note: `display text differs: "${tgtVal}" vs "${ourVal}"` };
  }

  // ---- coding values (system/code) ----
  if (/\.(system|code)$/.test(path) && /coding|valueCoding|type\.coding/.test(path) === false) {
    // fall through to generic below
  }

  // ---- everything else: a changed scalar = real-gap (regression-shaped) ----
  return { kind: "real-gap", note: `value differs: ${JSON.stringify(tgtVal)} vs ${JSON.stringify(ourVal)}` };
}

// classify a path that is present in target but ABSENT in our resource
function classifyMissing(rt: string, path: string, tgtVals: any[]): { kind: string; note: string } {
  // coding under a standard system -> coding-gap bucket
  if (/coding/.test(path) && /\.(system|code|display)$/.test(path)) {
    const sys = tgtVals.find((v) => typeof v === "string" && STANDARD_SYS.test(v));
    if (sys || /\.code$/.test(path) || /\.display$/.test(path)) return { kind: "coding-gap", note: `missing standard coding element (e.g. ${JSON.stringify(tgtVals[0])})` };
  }
  // a whole coding/system that is a standard terminology
  if (/\.system$/.test(path)) {
    const sys = tgtVals.find((v) => typeof v === "string" && STANDARD_SYS.test(v));
    if (sys) return { kind: "coding-gap", note: `missing standard system ${sys}` };
  }
  return { kind: "real-gap", note: `target has path, ours omits (e.g. ${JSON.stringify(tgtVals[0])})` };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const only = process.argv[2];
const types = only ? [only] : targetTypes;

const deltas: Delta[] = [];
let resourceLevelGaps = 0;
const perTypeSummary: { type: string; tgt: number; our: number; matched: number; tgtOnly: number }[] = [];

for (const type of types) {
  const tgt = load(TARGET_DIR, type);
  const our = load(OUT_DIR, type);
  const { pairs, tgtOnly } = align(type, tgt, our);
  perTypeSummary.push({ type, tgt: tgt.length, our: our.length, matched: pairs.length, tgtOnly: tgtOnly.length });

  // resource-level: target resources with no match = whole-resource real-gap
  for (const t of tgtOnly) {
    resourceLevelGaps++;
    deltas.push({
      rt: type, path: "(whole resource)", kind: "real-gap",
      tgt: naturalKeys(type, t)[0], our: null,
      note: `target ${type} has no aligned resource in out/ (natural key ${naturalKeys(type, t)[0]})`,
    });
  }

  // element-level: diff each matched pair
  for (const [t, o] of pairs) {
    const tf = flat(t), of = flat(o);
    const allPaths = new Set<string>([...tf.keys(), ...of.keys()]);
    for (const path of allPaths) {
      if (path === "id" || /^id$/.test(path)) continue; // synthetic id is expected-different
      const tv = tf.get(path), ov = of.get(path);
      // byte-identical multiset? skip.
      const tset = (tv ?? []).map((x) => JSON.stringify(x)).sort();
      const oset = (ov ?? []).map((x) => JSON.stringify(x)).sort();
      if (JSON.stringify(tset) === JSON.stringify(oset)) continue;

      if (tv && !ov) {
        const { kind, note } = classifyMissing(type, path, tv);
        deltas.push({ rt: type, path, kind, tgt: tv[0], our: null, note });
      } else if (!tv && ov) {
        // we have something target lacks — extra (not a target gap; observation only)
        deltas.push({ rt: type, path, kind: "unsure", tgt: null, our: ov[0], note: `present in ours, absent in target (e.g. ${JSON.stringify(ov[0])})` });
      } else {
        // both present: subtract the COMMON multiset, only diff what's genuinely unmatched.
        // (avoids "value differs: loinc vs loinc" artifacts when a coding[] array merely has
        //  an extra/missing entry in a different order.)
        const tRem = [...(tv as any[])];
        const oRem = [...(ov as any[])];
        for (let i = tRem.length - 1; i >= 0; i--) {
          const j = oRem.findIndex((x) => JSON.stringify(x) === JSON.stringify(tRem[i]));
          if (j >= 0) { oRem.splice(j, 1); tRem.splice(i, 1); }
        }
        if (tRem.length === 0 && oRem.length === 0) {
          // identical multiset, only the (collapsed) order differed -> nothing to report
        } else if (tRem.length && oRem.length) {
          // a genuine value substitution: pair the leftovers
          const { kind, note } = classifyValue(type, path, tRem[0], oRem[0], tf, of);
          deltas.push({ rt: type, path, kind, tgt: tRem[0], our: oRem[0], note });
        } else if (tRem.length) {
          // target has value(s) we don't emit at this leaf -> missing
          const { kind, note } = classifyMissing(type, path, tRem);
          deltas.push({ rt: type, path, kind, tgt: tRem[0], our: null, note: `${note} [array cardinality: tgt has unmatched value(s)]` });
        } else {
          // we emit extra value(s) target lacks at this leaf
          deltas.push({ rt: type, path, kind: "unsure", tgt: null, our: oRem[0], note: `our-only value at multi-valued path (e.g. ${JSON.stringify(oRem[0])})` });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// cluster by resourceType.path
// ---------------------------------------------------------------------------
type Cluster = { path: string; kind: string; count: number; example: string; tgt: any; our: any };
const clusterMap = new Map<string, Cluster>();
for (const d of deltas) {
  const ckey = `${d.rt}.${d.path}`;
  const ex = clusterMap.get(ckey);
  if (ex) { ex.count++; }
  else clusterMap.set(ckey, {
    path: ckey, kind: d.kind, count: 1,
    example: d.note, tgt: d.tgt, our: d.our,
  });
}
const clusters = [...clusterMap.values()].sort((a, b) => b.count - a.count);

// kind tally
const kindTally: Record<string, number> = {};
for (const d of deltas) kindTally[d.kind] = (kindTally[d.kind] || 0) + 1;

// ---------------------------------------------------------------------------
// write DELTAS.md
// ---------------------------------------------------------------------------
mkdirSync(resolve(ROOT, "compare"), { recursive: true });
const lines: string[] = [];
lines.push("# DELTAS — natural-key divergence survey (PROPOSE MODE, observation only)");
lines.push("");
lines.push(`Generated by \`compare/propose.ts\` on ${new Date().toISOString().slice(0, 10)}. `);
lines.push("Aligns `out/` to `fhir-target/` by NATURAL KEY per type (NOT FHIR id), then records every");
lines.push("non-byte-identical element with a FIRST-GUESS kind. **Nothing is permitted here** — these");
lines.push("are heuristic guesses to seed a tolerance registry, not approvals.");
lines.push("");
lines.push("## Totals");
lines.push("");
lines.push(`- total deltas: **${deltas.length}**`);
lines.push(`- distinct clusters (resourceType.path): **${clusters.length}**`);
lines.push(`- whole-resource real-gaps (unaligned target resources): **${resourceLevelGaps}**`);
lines.push("");
lines.push("### First-guess kind tally");
lines.push("");
lines.push("| kind | deltas |");
lines.push("|---|---:|");
for (const [k, v] of Object.entries(kindTally).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
lines.push("");
lines.push("## Alignment per type");
lines.push("");
lines.push("| type | target | ours | matched | target-only (unaligned) |");
lines.push("|---|---:|---:|---:|---:|");
for (const s of perTypeSummary) lines.push(`| ${s.type} | ${s.tgt} | ${s.our} | ${s.matched} | ${s.tgtOnly} |`);
lines.push("");
lines.push("### Alignment caveats (low match rate = survey under-pairs, NOT proof of gap)");
lines.push("");
lines.push("- **Observation** pairs only when a LOINC code (or `code.text`) AND effective time match.");
lines.push("  Our vitals carry NO LOINC and sit on different effective timestamps than the target's,");
lines.push("  so vitals/smartdata under-pair and surface as whole-resource real-gaps + our-only deltas.");
lines.push("  Treat the 298 unaligned Observations as a MIX of true under-production (smartdata=118 we");
lines.push("  emit 0) and pairing failure (vitals), to be split before any toleration decision.");
lines.push("- **Practitioner/DocumentReference/CarePlan** target-only counts are real under-production");
lines.push("  OR key misses; confirm per resource. None of this is tolerated here — it is observation.");
lines.push("");
lines.push("## Clusters (by resourceType.path, desc by count)");
lines.push("");
lines.push("| resourceType.path | first-guess kind | count | example |");
lines.push("|---|---|---:|---|");
for (const c of clusters) {
  const ex = c.example.replace(/\|/g, "\\|").slice(0, 160);
  lines.push(`| \`${c.path}\` | ${c.kind} | ${c.count} | ${ex} |`);
}
lines.push("");
lines.push("## Notes on classification heuristics");
lines.push("");
lines.push("- **isomorphic-ref**: reference resolves to the same natural key on both sides (id differs only).");
lines.push("- **specificity-ref**: our referent is same-or-narrower than target, VERIFIED by a parent/child");
lines.push("  join in the EHI org/location tree (CLARITY_DEP/CLARITY_SA). Unjoinable brand/department pairs");
lines.push("  fall to **unsure** (candidate for a BLESSED per-case attestation, not auto-toleration).");
lines.push("- **cosmetic-display**: display/text equal after normalize, or nickname/abbreviation containment.");
lines.push("- **coding-gap**: a missing standard coding (LOINC/SNOMED/RxNorm/ICD/CVX/CPT) — own bucket.");
lines.push("- **real-gap**: a changed scalar or a value present in target but missing from ours.");
lines.push("- **unsure**: needs human eyes (different-entity ref, divergent display, or our-only element).");
writeFileSync(resolve(ROOT, "compare/DELTAS.md"), lines.join("\n"));

// ---------------------------------------------------------------------------
// stdout
// ---------------------------------------------------------------------------
console.log(`\nTotal deltas: ${deltas.length}  |  clusters: ${clusters.length}  |  whole-resource gaps: ${resourceLevelGaps}`);
console.log("\nKind tally:", JSON.stringify(kindTally));
console.log("\nTop clusters:");
console.log("PATH".padEnd(52), "KIND".padEnd(18), "CNT");
for (const c of clusters.slice(0, 40)) console.log(c.path.padEnd(52), c.kind.padEnd(18), String(c.count).padStart(4));
console.log("\nWrote compare/DELTAS.md");

// emit JSON for the orchestrator to read if needed
writeFileSync(resolve(ROOT, "compare/deltas.json"), JSON.stringify({ total: deltas.length, clusters, kindTally }, null, 2));
