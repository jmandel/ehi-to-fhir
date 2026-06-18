#!/usr/bin/env bun
/**
 * classify.ts — TOLERANCE-AWARE compare. The enforcement counterpart of compare/propose.ts.
 *
 * propose.ts SURVEYS divergences with heuristic first-guess kinds and permits nothing.
 * classify.ts CLASSIFIES every target element as exactly one of:
 *     EXACT        — byte-identical (per multiset) to our aligned value
 *     TOLERATED    — matched an APPROVED registry rule whose predicate VERIFIED the
 *                    justified divergence from data (records ruleId + evidence)
 *     GAP(class)   — everything else, bucketed: coding-gap | real-gap | unsure
 *
 * Reconciliation invariant (asserted at runtime): exact + tolerated + gap = total target
 * elements. Nothing is silently dropped. A blessed-value rule tolerates ONLY when BOTH the
 * target value AND our value equal its pinned pair; any other value -> GAP.
 *
 *   bun compare/classify.ts            # full ledger -> compare/LEDGER.json + stdout + TOLERANCES.md
 *   bun compare/classify.ts Encounter  # restrict to one type (debug)
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { norm, type ClassifyContext } from "./classify-lib";
import { MECHANICAL, BLESSED, DROPPED, RULES, type Rule } from "./tolerances";

const ROOT = resolve(import.meta.dir, "..");
const TARGET_DIR = resolve(ROOT, "fhir-target");

// OUT dir is parameterizable so we can score the baseline (out/, default) OR the
// crosswalk-enriched output (out-crosswalk/). Precedence: env OUT_DIR > --out=<dir>
// CLI flag > default "out". Accepts an absolute path or a path relative to ROOT.
function resolveOutDir(): string {
  const cliArg = process.argv.find((a) => a.startsWith("--out="));
  const raw = process.env.OUT_DIR || (cliArg ? cliArg.slice("--out=".length) : "out");
  return resolve(ROOT, raw);
}
const OUT_DIR = resolveOutDir();

// EXCLUDE_SMARTDATA=1 drops the 118 physical-exam "SmartData" Observations from BOTH
// sides before classification. They are a KNOWN export-config gap (SMRTDTA_ELEM_DATA is
// not shipped), so including them lets that one gap dominate the residual. Default off
// (preserves existing behavior); turn on for the smartdata-excluded view.
const EXCLUDE_SMARTDATA = process.env.EXCLUDE_SMARTDATA === "1";
function isSmartData(r: any): boolean {
  if (r?.resourceType !== "Observation") return false;
  for (const c of r.category || [])
    for (const cc of c.coding || []) if (cc.code === "smartdata") return true;
  return false;
}

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

function dropSmartData(arr: any[]): any[] {
  return EXCLUDE_SMARTDATA ? arr.filter((r) => !isSmartData(r)) : arr;
}

const TARGET_ALL = dropSmartData(loadAll(TARGET_DIR));
const OUT_ALL = dropSmartData(loadAll(OUT_DIR));

// ---------------------------------------------------------------------------
// entity index: fhirId -> full resource (so a rule can resolve "Type/id" -> resource)
// ---------------------------------------------------------------------------
function indexById(all: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of all) if (r?.resourceType && r?.id) m.set(`${r.resourceType}/${r.id}`, r);
  return m;
}
const TGT_BY_ID = indexById(TARGET_ALL);
const OUR_BY_ID = indexById(OUT_ALL);

// ---------------------------------------------------------------------------
// data joins for predicates: CLARITY_DEP department table + location-name uniqueness
// ---------------------------------------------------------------------------
const deptCache = new Map<string, { DEPARTMENT_NAME: string; EXTERNAL_NAME: string } | null>();
let dbHandle: any = null;
function getDb(): any {
  if (dbHandle !== null) return dbHandle;
  try {
    dbHandle = require(resolve(ROOT, "lib/db")).db;
  } catch {
    dbHandle = false;
  }
  return dbHandle;
}
function department(departmentId: string) {
  if (deptCache.has(departmentId)) return deptCache.get(departmentId)!;
  const db = getDb();
  let row: any = null;
  if (db) {
    try {
      row = db
        .prepare("SELECT DEPARTMENT_NAME, EXTERNAL_NAME FROM CLARITY_DEP WHERE DEPARTMENT_ID = ?")
        .get(departmentId);
    } catch {}
  }
  const val = row ? { DEPARTMENT_NAME: row.DEPARTMENT_NAME, EXTERNAL_NAME: row.EXTERNAL_NAME } : null;
  deptCache.set(departmentId, val);
  return val;
}

// ---------------------------------------------------------------------------
// Encounter standard v3-ActCode class our builder DERIVES from the encounter's ADT patient class.
// Mirrors src/encounter.ts buildClass() EXACTLY (same enum map, same precedence PAT_ENC_HSP ?? PAT_ENC_2)
// so the Encounter.class standard-vs-Epic-local tolerance can verify our emitted class is the correct
// ADT-class-derived standard mapping. We replicate (not import) the small map to keep compare/ self-
// contained and edit-scoped; it is a legitimate terminology map, not per-CSN hardcoding.
// ---------------------------------------------------------------------------
const SYS_ACTCODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
function adtClassToStd(clsRaw: string): { system: string; code: string; display: string } {
  const cls = (clsRaw || "").trim().toLowerCase();
  switch (cls) {
    case "inpatient":
      return { system: SYS_ACTCODE, code: "IMP", display: "inpatient encounter" };
    case "emergency":
      return { system: SYS_ACTCODE, code: "EMER", display: "emergency" };
    case "observation":
      return { system: SYS_ACTCODE, code: "OBSENC", display: "observation encounter" };
    case "outpatient":
    case "therapies series":
      return { system: SYS_ACTCODE, code: "AMB", display: "ambulatory" };
    default:
      return { system: SYS_ACTCODE, code: "AMB", display: "ambulatory" };
  }
}
const encStdClassCache = new Map<string, { system: string; code: string; display: string } | null>();
function encounterStdClass(csn: string): { system: string; code: string; display: string } | null {
  if (!csn) return null;
  if (encStdClassCache.has(csn)) return encStdClassCache.get(csn)!;
  const db = getDb();
  if (!db) {
    encStdClassCache.set(csn, null);
    return null;
  }
  let adt = "";
  try {
    const h = db.prepare("SELECT ADT_PAT_CLASS_C_NAME FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?").get(String(csn));
    const e = db.prepare("SELECT ADT_PAT_CLASS_C_NAME FROM PAT_ENC_2 WHERE PAT_ENC_CSN_ID = ?").get(String(csn));
    adt = (h?.ADT_PAT_CLASS_C_NAME || e?.ADT_PAT_CLASS_C_NAME || "") as string;
  } catch {
    encStdClassCache.set(csn, null);
    return null;
  }
  const val = adtClassToStd(adt);
  encStdClassCache.set(csn, val);
  return val;
}

// normalized Location.name uniqueness per side (fail-closed pre-check)
function locationNamesUniqueFor(all: any[]): boolean {
  const seen = new Set<string>();
  for (const r of all) {
    if (r?.resourceType !== "Location") continue;
    const n = norm(r.name);
    if (!n) continue;
    if (seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}
const TGT_LOC_UNIQUE = locationNamesUniqueFor(TARGET_ALL);
const OUR_LOC_UNIQUE = locationNamesUniqueFor(OUT_ALL);

// Specimen accession (identifier.value @ .798268.320) -> count of distinct Specimens per side.
// Accession is NON-INJECTIVE (e.g. H613684 -> 3 Specimens), so a specimen-by-accession ref may
// only be tolerated when its accession value resolves to exactly one Specimen on that side.
const SPECIMEN_ACCESSION_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.3.798268.320";
function specimenAccessionCounts(all: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of all) {
    if (r?.resourceType !== "Specimen") continue;
    const vals = [
      ...new Set(
        (r.identifier || [])
          .filter((i: any) => i.system === SPECIMEN_ACCESSION_OID && i.value != null)
          .map((i: any) => String(i.value).trim())
          .filter(Boolean),
      ),
    ];
    if (vals.length !== 1) continue; // a Specimen with 0 or >1 accession is itself ambiguous
    const a = vals[0] as string;
    m.set(a, (m.get(a) || 0) + 1);
  }
  return m;
}
const TGT_SPEC_ACC = specimenAccessionCounts(TARGET_ALL);
const OUR_SPEC_ACC = specimenAccessionCounts(OUT_ALL);

// ---------------------------------------------------------------------------
// natural-key alignment (same logic as propose.ts) — target<->our pairing
// ---------------------------------------------------------------------------
const norm2 = norm;
function effective(r: any): string {
  return (
    r.effectiveDateTime || r.effectivePeriod?.start || r.onsetDateTime || r.onsetPeriod?.start ||
    r.authoredOn || r.recordedDate || r.period?.start || r.date || r.created || ""
  );
}
function loincOf(r: any): string {
  return (
    (r.code?.coding || []).filter((c: any) => /loinc/.test(c.system || "")).map((c: any) => c.code).sort().join(",") || ""
  );
}
function naturalKeys(type: string, r: any): string[] {
  const idents = (r.identifier || []).map((i: any) => norm2(i.value)).filter(Boolean);
  switch (type) {
    case "Patient":
    case "CareTeam":
    case "Goal":
    case "Coverage":
      return ["singleton"];
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
      return idents.length ? idents : [norm2(r.code?.text)];
  }
}
function align(type: string, tgt: any[], our: any[]): { pairs: [any, any][]; tgtOnly: any[]; ourOnly: any[] } {
  const ourByKey = new Map<string, any[]>();
  for (const o of our) for (const k of naturalKeys(type, o)) (ourByKey.get(k) ?? ourByKey.set(k, []).get(k)!).push(o);
  const pairs: [any, any][] = [];
  const usedOur = new Set<any>();
  const tgtOnly: any[] = [];
  for (const t of tgt) {
    let matched: any = null;
    for (const k of naturalKeys(type, t)) {
      const cands = ourByKey.get(k);
      if (cands) {
        const c = cands.find((x) => !usedOur.has(x));
        if (c) {
          matched = c;
          break;
        }
      }
    }
    if (matched) {
      pairs.push([t, matched]);
      usedOur.add(matched);
    } else tgtOnly.push(t);
  }
  const ourOnly = our.filter((o) => !usedOur.has(o));
  return { pairs, tgtOnly, ourOnly };
}

// ---------------------------------------------------------------------------
// basedOn order-equivalence map (FAIL-CLOSED bijection) for the basedOn iso-ref family.
// The target ServiceRequest is opaque + ABSENT from the target export, and the order display is
// non-injective (one panel ordered on two dates shares the display). So neither resolution nor
// display can key the same order. Instead we observe the (target basedOn ref -> our basedOn ref)
// pairing across ALL aligned Observation/DiagnosticReport.basedOn leaves (paired positionally
// within the aligned resource pair, which is keyed by LOINC/code + effective instant), and keep a
// target->our mapping ONLY where it is a strict BIJECTION. A re-point to a different order makes a
// target ref co-occur with two distinct our refs -> ambiguous -> dropped -> GAP.
// ---------------------------------------------------------------------------
function buildBasedOnOrderMap(): Map<string, string> {
  const t2o = new Map<string, Set<string>>(); // target ref -> our refs seen
  const o2t = new Map<string, Set<string>>(); // our ref -> target refs seen
  const add = (tr: any, or: any) => {
    if (typeof tr !== "string" || typeof or !== "string") return;
    if (!tr.startsWith("ServiceRequest/") || !or.startsWith("ServiceRequest/")) return;
    (t2o.get(tr) ?? t2o.set(tr, new Set()).get(tr)!).add(or);
    (o2t.get(or) ?? o2t.set(or, new Set()).get(or)!).add(tr);
  };
  for (const type of ["Observation", "DiagnosticReport"]) {
    const tgt = dropSmartData(load(TARGET_DIR, type));
    const our = dropSmartData(load(OUT_DIR, type));
    const { pairs } = align(type, tgt, our);
    for (const [t, o] of pairs) {
      const tb = (t.basedOn || []) as any[];
      const ob = (o.basedOn || []) as any[];
      const n = Math.min(tb.length, ob.length);
      for (let i = 0; i < n; i++) add(tb[i]?.reference, ob[i]?.reference);
    }
  }
  // keep ONLY strict-bijection keys: target ref maps to exactly one our ref AND that our ref maps
  // back to exactly one target ref. Anything ambiguous on either side is dropped (-> GAP).
  const bij = new Map<string, string>();
  for (const [tr, ours] of t2o) {
    if (ours.size !== 1) continue;
    const or = [...ours][0];
    if ((o2t.get(or)?.size ?? 0) !== 1) continue;
    bij.set(tr, or);
  }
  return bij;
}
const BASEDON_ORDER_MAP = buildBasedOnOrderMap();

// ---------------------------------------------------------------------------
// GENERALIZED opaque-target iso-ref bijection (same fail-closed machinery as
// buildBasedOnOrderMap, factored for other reference fields whose TARGET id is an
// opaque Epic server id absent from the target export — so neither resolution nor a
// natural key can prove same-entity directly). We observe the (target ref -> our ref)
// pairing across ALL aligned resource pairs at a reference path and keep ONLY strict
// bijections. A re-point to a different entity makes a target ref co-occur with two
// our refs -> ambiguous -> dropped -> GAP. (User-approved extension of the attachment
// opaque-id ruling to: medicationReference [1:1 per ORDER_MED], specimen.reference,
// and Condition.evidence.detail.)
// ---------------------------------------------------------------------------
function buildRefBijectionMap(
  specs: { type: string; refs: (res: any) => any[] }[],
  prefix: string,
): Map<string, string> {
  const t2o = new Map<string, Set<string>>();
  const o2t = new Map<string, Set<string>>();
  const add = (tr: any, or: any) => {
    if (typeof tr !== "string" || typeof or !== "string") return;
    if (!tr.startsWith(prefix) || !or.startsWith(prefix)) return;
    (t2o.get(tr) ?? t2o.set(tr, new Set()).get(tr)!).add(or);
    (o2t.get(or) ?? o2t.set(or, new Set()).get(or)!).add(tr);
  };
  for (const s of specs) {
    const tgt = dropSmartData(load(TARGET_DIR, s.type));
    const our = dropSmartData(load(OUT_DIR, s.type));
    const { pairs } = align(s.type, tgt, our);
    for (const [t, o] of pairs) {
      const tr = s.refs(t), or = s.refs(o);
      const n = Math.min(tr.length, or.length); // positional within the aligned resource pair
      for (let i = 0; i < n; i++) add(tr[i], or[i]);
    }
  }
  const bij = new Map<string, string>();
  for (const [tr, ours] of t2o) {
    if (ours.size !== 1) continue;
    const or = [...ours][0];
    if ((o2t.get(or)?.size ?? 0) !== 1) continue;
    bij.set(tr, or);
  }
  return bij;
}
// Scope registry for opaque-target STRUCTURAL references — each is a reference whose referent is
// structurally determined by the (aligned) parent resource, so within an aligned pair the two sides
// necessarily point at the SAME entity and only the id scheme (our minted vs Epic opaque) differs.
// EXCLUDED on purpose: DiagnosticReport.performer (a performer org can be GENUINELY different —
// target "UPH MADISON SUNQUEST LAB" vs our "...MERITER LAB" — so a consistent pairing there would
// mask a real org mismatch; that stays a GAP / is adjudicated separately).
const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
const BIJECTION_SPECS: { scope: string; type: string; prefix: string; refs: (r: any) => any[] }[] = [
  { scope: "MedicationRequest.medicationReference.reference", type: "MedicationRequest", prefix: "Medication/", refs: (r) => (r.medicationReference?.reference ? [r.medicationReference.reference] : []) },
  { scope: "Observation.specimen.reference", type: "Observation", prefix: "Specimen/", refs: (r) => (r.specimen?.reference ? [r.specimen.reference] : []) },
  { scope: "DiagnosticReport.specimen[].reference", type: "DiagnosticReport", prefix: "Specimen/", refs: (r) => arr(r.specimen).map((s) => s?.reference).filter(Boolean) },
  { scope: "Condition.evidence[].detail[].reference", type: "Condition", prefix: "Condition/", refs: (r) => arr(r.evidence).flatMap((e) => arr(e?.detail).map((d) => d?.reference)).filter(Boolean) },
  { scope: "Observation.derivedFrom[].reference", type: "Observation", prefix: "Observation/", refs: (r) => arr(r.derivedFrom).map((d) => d?.reference).filter(Boolean) },
  { scope: "MedicationRequest.priorPrescription.reference", type: "MedicationRequest", prefix: "MedicationRequest/", refs: (r) => (r.priorPrescription?.reference ? [r.priorPrescription.reference] : []) },
  { scope: "MedicationRequest.encounter.reference", type: "MedicationRequest", prefix: "Encounter/", refs: (r) => (r.encounter?.reference ? [r.encounter.reference] : []) },
  { scope: "Immunization.encounter.reference", type: "Immunization", prefix: "Encounter/", refs: (r) => (r.encounter?.reference ? [r.encounter.reference] : []) },
  { scope: "Condition.encounter.reference", type: "Condition", prefix: "Encounter/", refs: (r) => (r.encounter?.reference ? [r.encounter.reference] : []) },
  { scope: "CarePlan.addresses[].reference", type: "CarePlan", prefix: "Condition/", refs: (r) => arr(r.addresses).map((a) => a?.reference).filter(Boolean) },
  { scope: "CarePlan.goal[].reference", type: "CarePlan", prefix: "Goal/", refs: (r) => arr(r.goal).map((g) => g?.reference).filter(Boolean) },
  { scope: "Coverage.payor[].reference", type: "Coverage", prefix: "Organization/", refs: (r) => arr(r.payor).map((p) => p?.reference).filter(Boolean) },
  { scope: "Patient.managingOrganization.reference", type: "Patient", prefix: "Organization/", refs: (r) => (r.managingOrganization?.reference ? [r.managingOrganization.reference] : []) },
];
const BIJECTION_MAPS = new Map<string, Map<string, string>>();
for (const s of BIJECTION_SPECS) BIJECTION_MAPS.set(s.scope, buildRefBijectionMap([{ type: s.type, refs: s.refs }], s.prefix));
function refBijectionMate(scope: string, targetRef: string): string | null {
  return BIJECTION_MAPS.get(scope)?.get(targetRef) ?? null;
}

// ---------------------------------------------------------------------------
// flatten to dotted paths (array idx collapsed to []), multiset of leaf values
// ---------------------------------------------------------------------------
function flatten(node: any, prefix: string, acc: Map<string, any[]>) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((it) => flatten(it, prefix + "[]", acc));
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, acc);
    return;
  }
  const cur = acc.get(prefix);
  if (cur === undefined) acc.set(prefix, [node]);
  else cur.push(node);
}
function flat(r: any): Map<string, any[]> {
  const m = new Map<string, any[]>();
  flatten(r, "", m);
  return m;
}

// -- NODE-AWARE leaf records: each leaf retains its OWNING OBJECT (true siblings) --
// This fixes multi-element arrays (e.g. Encounter.participant[]) where flatten-to-multiset
// loses the within-element association between .display and its own .reference.
type LeafRec = { path: string; value: any; owner: any };
function collectLeaves(node: any, prefix: string, owner: any, acc: LeafRec[]) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((it) => collectLeaves(it, prefix + "[]", it && typeof it === "object" && !Array.isArray(it) ? it : owner, acc));
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectLeaves(v, prefix ? `${prefix}.${k}` : k, node, acc);
    return;
  }
  acc.push({ path: prefix, value: node, owner });
}
function leaves(r: any): LeafRec[] {
  const acc: LeafRec[] = [];
  collectLeaves(r, "", r, acc);
  return acc;
}
// read a sibling element value from an owner object by its LAST path token (e.g. "reference"),
// walking nested wrapper objects when the rule asks for "individual.reference" or "location.reference".
function siblingFromOwner(owner: any, relPath: string): any {
  if (!owner || typeof owner !== "object") return undefined;
  const parts = relPath.split(".");
  let cur: any = owner;
  // try full descent first (owner already IS the wrapper, so the last token is what we want)
  // relPath like "individual.reference": owner is the participant element -> owner.individual.reference
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else { cur = undefined; break; }
  }
  // Return the full-descent value when defined. Scalars (the common case: .reference/.code/.system)
  // are returned as before; ARRAYS/OBJECTS are ALSO returned now (e.g. a CodeableConcept .text rule
  // reading its sibling "coding" array). No existing rule relied on getting undefined for an object
  // sibling, so this only ADDS the ability to read a non-scalar sibling.
  if (cur !== undefined) return cur;
  // fallback: the last token directly on owner (owner already the wrapper, e.g. individual{})
  const last = parts[parts.length - 1];
  if (owner[last] !== undefined) return owner[last];
  return undefined;
}

const STANDARD_SYS = /(loinc|snomed|rxnorm|fhir\/sid|cvx|hl7\.org\/fhir\/sid|ndc|ama-assn|cpt|icd)/i;

// gap sub-class for a target element with no toleration
function gapClassValue(path: string): "coding-gap" {
  return "coding-gap";
}
function gapClassMissing(path: string, tgtVals: any[]): "coding-gap" | "real-gap" {
  if (/coding/.test(path) && /\.(system|code|display)$/.test(path)) {
    const sys = tgtVals.find((v) => typeof v === "string" && STANDARD_SYS.test(v));
    if (sys || /\.code$/.test(path) || /\.display$/.test(path)) return "coding-gap";
  }
  if (/\.system$/.test(path)) {
    const sys = tgtVals.find((v) => typeof v === "string" && STANDARD_SYS.test(v));
    if (sys) return "coding-gap";
  }
  return "real-gap";
}
function gapClassChanged(path: string): "coding-gap" | "real-gap" | "unsure" {
  if (/coding/.test(path) && /\.(system|code|display)$/.test(path)) return "coding-gap";
  if (/\.display$/.test(path) || /\.text$/.test(path)) return "unsure"; // display drift we couldn't tolerate
  if (/\.reference$/.test(path)) return "unsure"; // a ref we couldn't tolerate -> needs eyes
  return "real-gap";
}

// ---------------------------------------------------------------------------
// rule application — by scope, with the narrow verifying predicate
// ---------------------------------------------------------------------------
const mechByScope = new Map<string, typeof MECHANICAL>();
for (const r of MECHANICAL) (mechByScope.get(r.scope) ?? mechByScope.set(r.scope, []).get(r.scope)!).push(r);
const blessedByScope = new Map<string, typeof BLESSED>();
for (const r of BLESSED) (blessedByScope.get(r.scope) ?? blessedByScope.set(r.scope, []).get(r.scope)!).push(r);

type Ledger = {
  exact: number;
  tolerated: { ruleId: string; rt: string; tgtId?: string; ourId?: string; path: string; evidence: string; targetVal: any; ourVal: any }[];
  gaps: { rt: string; tgtId?: string; ourId?: string; path: string; cls: string; targetVal: any; ourVal: any; note: string }[];
};

const ledger: Ledger = { exact: 0, tolerated: [], gaps: [] };
const ruleHits: Record<string, number> = {};
for (const r of RULES) ruleHits[r.id] = 0;

// Single optional positional TYPE filter. Must skip --flags (e.g. --out=<dir>) so the
// flag never shadows the type arg: `bun compare/classify.ts --out=out-crosswalk` has no
// type filter (runs all types), while `bun compare/classify.ts Encounter --out=foo` filters
// to Encounter. (Previously argv[2] grabbed `--out=...` as the type, classifying nothing.)
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
const types = only ? [only] : targetTypes;

let totalTargetElements = 0;
const perTypeSummary: { type: string; tgt: number; our: number; matched: number; tgtOnly: number }[] = [];
// per-resource-type EXACT/TOLERATED/GAP element tally (for the status scorecard; reconciles per type).
const perType: Record<string, { exact: number; tolerated: number; gap: number }> = {};
const pt = (t: string) => (perType[t] ??= { exact: 0, tolerated: 0, gap: 0 });
// viewer pairing + extras (powers tools/build-viewer.ts side-by-side views)
const viewerPairs: { rt: string; tgtId: string; ourId: string; key: string }[] = [];
const viewerOurOnly: { rt: string; ourId: string; key: string }[] = [];

// build a NODE-AWARE ctx: targetAt/ourAt read true siblings from the captured owner objects.
function makeCtx(
  rt: string,
  fullPath: string,
  targetVal: any,
  ourVal: any,
  tOwner: any,
  oOwner: any,
  tRoot: any,
  oRoot: any,
): ClassifyContext {
  return {
    resourceType: rt,
    path: fullPath,
    targetVal,
    ourVal,
    resolve: (ref, side) => (side === "tgt" ? TGT_BY_ID : OUR_BY_ID).get(ref) || null,
    // sibling lookup reads from the SAME owner object that holds this leaf (correct within
    // multi-element arrays). relPath is the rule's "<...>.reference" style; we take its tail.
    targetAt: (relPath) => siblingFromOwner(tOwner, relPath),
    ourAt: (relPath) => siblingFromOwner(oOwner, relPath),
    targetRoot: tRoot,
    ourRoot: oRoot,
    department,
    locationNamesUnique: (side) => (side === "tgt" ? TGT_LOC_UNIQUE : OUR_LOC_UNIQUE),
    specimenAccessionUnique: (side, accession) =>
      (side === "tgt" ? TGT_SPEC_ACC : OUR_SPEC_ACC).get(accession) === 1,
    basedOnOrderMate: (targetRef) => BASEDON_ORDER_MAP.get(targetRef) ?? null,
    refBijectionMate: (scope, targetRef) => refBijectionMate(scope, targetRef),
    encounterStdClass: (csn) => encounterStdClass(csn),
  };
}

// try to tolerate a CHANGED value (both sides present) at fullPath, using the leaves' owner nodes.
function tryTolerateChanged(
  rt: string,
  fullPath: string,
  targetVal: any,
  ourVal: any,
  tOwner: any,
  oOwner: any,
  tRoot: any,
  oRoot: any,
): { ruleId: string; evidence: string } | null {
  // blessed-value: pin BOTH exact values
  for (const b of blessedByScope.get(fullPath) || []) {
    if (String(targetVal) === b.pinTargetValue && String(ourVal) === b.pinOurValue) {
      return { ruleId: b.id, evidence: `pinned pair ("${b.pinTargetValue}","${b.pinOurValue}")` };
    }
  }
  // mechanical: run the verifying predicate
  for (const m of mechByScope.get(fullPath) || []) {
    const ctx = makeCtx(rt, fullPath, targetVal, ourVal, tOwner, oOwner, tRoot, oRoot);
    let ev: string | null = null;
    try {
      ev = m.verify(ctx);
    } catch {
      ev = null;
    }
    if (ev) return { ruleId: m.id, evidence: ev };
  }
  return null;
}

// try to tolerate a MISSING value (target present, OUR side omits the leaf entirely) at fullPath.
// Only rules explicitly flagged appliesWhenOurAbsent are consulted; their verify sees ourVal=null and
// must establish the "our side legitimately absent" equivalence from the ROOTS/siblings (e.g. a
// server-stamped ValueSet .version whose status concept our side still emits). No our-side owner exists
// (the leaf is absent), so the our owner is null; the verify climbs to oRoot for any our-side check.
function tryTolerateMissing(
  rt: string,
  fullPath: string,
  targetVal: any,
  tOwner: any,
  tRoot: any,
  oRoot: any,
): { ruleId: string; evidence: string } | null {
  for (const m of mechByScope.get(fullPath) || []) {
    if (!(m as any).appliesWhenOurAbsent) continue;
    const ctx = makeCtx(rt, fullPath, targetVal, null, tOwner, null, tRoot, oRoot);
    let ev: string | null = null;
    try {
      ev = m.verify(ctx);
    } catch {
      ev = null;
    }
    if (ev) return { ruleId: m.id, evidence: ev };
  }
  return null;
}

// Pair a target leaf to the BEST our leaf at the same path. For scopes the registry governs by a
// sibling reference (the cosmetic-display family), we pair by resolving each side's sibling-ref
// natural key so the .display is checked against ITS OWN .reference even in multi-element arrays.
// Returns the chosen index into oLeaves or -1.
function pickOurLeaf(fullPath: string, tLeaf: LeafRec, oLeaves: LeafRec[], used: Set<number>): number {
  // does a registry rule for this scope read a sibling reference? (display rules do)
  const rule = (mechByScope.get(fullPath) || [])[0];
  const refTail = /\.display$/.test(fullPath) ? fullPath.replace(/^.*\./, "").replace(/.*/, "reference") : null;
  if (rule && /\.display$/.test(fullPath)) {
    // sibling reference natural key on the target leaf's owner
    const tref = siblingFromOwner(tLeaf.owner, "reference");
    const tkey = refNaturalKey(tref, "tgt");
    if (tkey) {
      // prefer an our leaf whose owner's sibling reference resolves to the same natural key
      for (let i = 0; i < oLeaves.length; i++) {
        if (used.has(i)) continue;
        const okey = refNaturalKey(siblingFromOwner(oLeaves[i].owner, "reference"), "our");
        if (okey && okey === tkey) return i;
      }
    }
  }
  // For the cosmetic-CASE coding-display / CodeableConcept-text family, pair by the owner's coded
  // concept so a .display/.text is compared against ITS OWN concept even when the reasonCode[] /
  // coding[] arrays are differently ordered or sized across sides (e.g. ours adds an extra reasonCode).
  // The concept key is symmetric (Epic OID system + code is byte-equal across sides), so a same-concept
  // pairing is found; if none matches, fall through to positional (verify still re-checks and GAPs a
  // mismatch). Only engaged for scopes a cosmetic-case rule governs.
  if (rule && (rule.id?.startsWith("cosmetic-case-") || rule.id?.startsWith("cosmetic-display-")) ) {
    const tkey = conceptPairKey(tLeaf.owner, fullPath);
    if (tkey) {
      for (let i = 0; i < oLeaves.length; i++) {
        if (used.has(i)) continue;
        if (conceptPairKey(oLeaves[i].owner, fullPath) === tkey) return i;
      }
    }
  }
  // default: first unused our leaf at this path
  for (let i = 0; i < oLeaves.length; i++) if (!used.has(i)) return i;
  return -1;
}

// Concept pairing key for a cosmetic-case leaf. For a coding[].display leaf the owner IS the coding
// object -> key on its {system,code}. For a CodeableConcept .text leaf the owner has a coding[] array
// -> key on the sorted {system,code} set. Returns null when no coded concept is present (un-pairable).
function conceptPairKey(owner: any, fullPath: string): string | null {
  if (!owner || typeof owner !== "object") return null;
  if (/\.text$/.test(fullPath)) {
    const set = (Array.isArray(owner.coding) ? owner.coding : [])
      .map((c: any) => `${norm(c?.system)}|${norm(c?.code)}`)
      .filter((k: string) => k !== "|")
      .sort();
    return set.length ? "set:" + set.join(",") : null;
  }
  // coding[].display leaf: owner is the coding object
  const sys = norm(owner.system), code = norm(owner.code);
  return code ? `cc:${sys}|${code}` : null;
}

// natural key of a reference for PAIRING (Patient PAT_ID / Practitioner SER / Location name / Encounter CSN).
function refNaturalKey(ref: any, side: "tgt" | "our"): string | null {
  if (typeof ref !== "string") return null;
  const res = (side === "tgt" ? TGT_BY_ID : OUR_BY_ID).get(ref);
  if (!res) return null;
  const t = res.resourceType;
  if (t === "Patient") {
    const id = (res.identifier || []).find((i: any) => i.system === "urn:oid:1.2.840.114350.1.13.283.2.7.2.698084" && i.value);
    return id ? "pat:" + norm(id.value) : "pat:singleton";
  }
  if (t === "Practitioner") {
    const ser = (res.identifier || []).find((i: any) => i.system === "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99" && /^\d{5,7}$/.test(String(i.value).trim()));
    return ser ? "ser:" + String(ser.value).trim() : null;
  }
  if (t === "Location") return res.name ? "loc:" + norm(res.name) : null;
  if (t === "Encounter") {
    const csn = (res.identifier || []).find((i: any) => i.system === "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8" && i.value);
    return csn ? "csn:" + String(csn.value).trim() : null;
  }
  return t + ":" + (res.id || "");
}

for (const type of types) {
  const tgt = dropSmartData(load(TARGET_DIR, type));
  const our = dropSmartData(load(OUT_DIR, type));
  const { pairs, tgtOnly, ourOnly } = align(type, tgt, our);
  perTypeSummary.push({ type, tgt: tgt.length, our: our.length, matched: pairs.length, tgtOnly: tgtOnly.length });
  // viewer pairing: target id <-> our id + natural key (powers the side-by-side viewer)
  for (const [t, o] of pairs) viewerPairs.push({ rt: type, tgtId: t.id, ourId: o.id, key: naturalKeys(type, t)[0] });
  for (const o of ourOnly || []) viewerOurOnly.push({ rt: type, ourId: o.id, key: naturalKeys(type, o)[0] });

  // unaligned target resources: every target element is a whole-resource real-gap (count as 1 element)
  for (const t of tgtOnly) {
    totalTargetElements++;
    pt(type).gap++;
    ledger.gaps.push({
      rt: type,
      tgtId: t.id,
      path: "(whole resource)",
      cls: "real-gap",
      targetVal: naturalKeys(type, t)[0],
      ourVal: null,
      note: `target ${type} has no aligned resource in out/ (natural key ${naturalKeys(type, t)[0]})`,
    });
  }

  for (const [t, o] of pairs) {
    // node-aware leaves grouped by path
    const tByPath = new Map<string, LeafRec[]>();
    for (const lf of leaves(t)) {
      if (lf.path === "id") continue; // synthetic id expected-different, not an owed element
      (tByPath.get(lf.path) ?? tByPath.set(lf.path, []).get(lf.path)!).push(lf);
    }
    const oByPath = new Map<string, LeafRec[]>();
    for (const lf of leaves(o)) (oByPath.get(lf.path) ?? oByPath.set(lf.path, []).get(lf.path)!).push(lf);

    // classify EVERY target leaf (the reconciliation domain)
    for (const [path, tLeaves] of tByPath) {
      const fullPath = `${type}.${path}`;
      const oLeaves = (oByPath.get(path) || []).slice();
      const usedOur = new Set<number>();

      // 1) remove byte-identical matches first (EXACT)
      const tRem: LeafRec[] = [];
      for (const tl of tLeaves) {
        let matched = -1;
        for (let i = 0; i < oLeaves.length; i++) {
          if (usedOur.has(i)) continue;
          if (JSON.stringify(oLeaves[i].value) === JSON.stringify(tl.value)) { matched = i; break; }
        }
        if (matched >= 0) {
          usedOur.add(matched);
          totalTargetElements++;
          ledger.exact++;
          pt(type).exact++;
        } else tRem.push(tl);
      }

      // 2) remaining target leaves: pair (sibling-ref aware) and try tolerate, else GAP
      for (const tl of tRem) {
        totalTargetElements++;
        const oi = pickOurLeaf(fullPath, tl, oLeaves, usedOur);
        if (oi >= 0) {
          usedOur.add(oi);
          const ol = oLeaves[oi];
          const tol = tryTolerateChanged(type, fullPath, tl.value, ol.value, tl.owner, ol.owner, t, o);
          if (tol) {
            ruleHits[tol.ruleId]++;
            pt(type).tolerated++;
            ledger.tolerated.push({ ruleId: tol.ruleId, rt: type, tgtId: t.id, ourId: o.id, path, evidence: tol.evidence, targetVal: tl.value, ourVal: ol.value });
            continue;
          }
          pt(type).gap++;
          ledger.gaps.push({
            rt: type,
            tgtId: t.id,
            ourId: o.id,
            path,
            cls: gapClassChanged(path),
            targetVal: tl.value,
            ourVal: ol.value,
            note: `changed value not tolerated by any approved rule`,
          });
        } else {
          // our side omits this leaf: consult ONLY the our-side-absent-flagged rules before GAPping.
          const tolM = tryTolerateMissing(type, fullPath, tl.value, tl.owner, t, o);
          if (tolM) {
            ruleHits[tolM.ruleId]++;
            pt(type).tolerated++;
            ledger.tolerated.push({ ruleId: tolM.ruleId, rt: type, tgtId: t.id, ourId: o.id, path, evidence: tolM.evidence, targetVal: tl.value, ourVal: null });
            continue;
          }
          pt(type).gap++;
          ledger.gaps.push({
            rt: type,
            tgtId: t.id,
            ourId: o.id,
            path,
            cls: gapClassMissing(path, [tl.value]),
            targetVal: tl.value,
            ourVal: null,
            note: `target has value, ours omits`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// reconciliation assertion
// ---------------------------------------------------------------------------
const exact = ledger.exact;
const tolerated = ledger.tolerated.length;
const gap = ledger.gaps.length;
const sum = exact + tolerated + gap;
const reconciles = sum === totalTargetElements;

// gap split by class
const gapByClass: Record<string, number> = {};
for (const g of ledger.gaps) gapByClass[g.cls] = (gapByClass[g.cls] || 0) + 1;

// tolerated split mechanical vs blessed + per-rule
const toleratedByRule: Record<string, number> = {};
for (const tdel of ledger.tolerated) toleratedByRule[tdel.ruleId] = (toleratedByRule[tdel.ruleId] || 0) + 1;
const mechRuleIds = new Set(MECHANICAL.map((r) => r.id));
let toleratedMechanical = 0;
let toleratedBlessed = 0;
for (const [rid, n] of Object.entries(toleratedByRule)) (mechRuleIds.has(rid) ? (toleratedMechanical += n) : (toleratedBlessed += n));

// over-cap flags
const overCap: { id: string; hits: number; cap: number }[] = [];
for (const r of RULES) if (ruleHits[r.id] > r.hitCap) overCap.push({ id: r.id, hits: ruleHits[r.id], cap: r.hitCap });

// provisional (human-signoff-pending) blessings
const provisional = BLESSED.filter((b) => b.approval.status === "provisional");

// ---------------------------------------------------------------------------
// stdout ledger
// ---------------------------------------------------------------------------
console.log("\n=== TOLERANCE-AWARE COMPARE LEDGER ===");
console.log(`config                : out=${OUT_DIR.replace(ROOT + "/", "")}  EXCLUDE_SMARTDATA=${EXCLUDE_SMARTDATA ? "1" : "0"}`);
console.log(`total target elements : ${totalTargetElements}`);
console.log(`  EXACT               : ${exact}`);
console.log(`  TOLERATED           : ${tolerated}  (mechanical ${toleratedMechanical} + blessed ${toleratedBlessed})`);
console.log(`  GAP                 : ${gap}  ${JSON.stringify(gapByClass)}`);
console.log(`reconciliation        : ${exact} + ${tolerated} + ${gap} = ${sum}  ${reconciles ? "OK ✓" : "FAIL ✗"} (total ${totalTargetElements})`);

console.log("\nPer-rule tolerated hits (cap):");
for (const r of RULES) {
  const flag = ruleHits[r.id] > r.hitCap ? "  ⚠ OVER CAP" : "";
  const tier = r.tier === "blessed" ? `blessed/${(r as any).signoff}` : (r as any).kind;
  console.log(`  ${r.id.padEnd(48)} ${String(ruleHits[r.id]).padStart(4)} / ${String(r.hitCap).padEnd(4)} [${tier}]${flag}`);
}
if (overCap.length) {
  console.log("\n⚠ OVER-CAP RULES (possible drift — investigate):");
  for (const o of overCap) console.log(`  ${o.id}: ${o.hits} > cap ${o.cap}`);
} else {
  console.log("\nNo rules over hit-cap.");
}
if (provisional.length) {
  console.log("\n⚠ PROVISIONAL BLESSINGS (human sign-off pending — applied but unconfirmed):");
  for (const b of provisional) console.log(`  ${b.id}  hits=${ruleHits[b.id]}  pin=("${b.pinTargetValue}","${b.pinOurValue}")`);
}
console.log(`\nDropped (rejected) candidate rules, never applied: ${DROPPED.map((d) => d.id).join(", ")}`);

if (!reconciles) {
  console.error("\nRECONCILIATION FAILED — exact+tolerated+gap != total target elements. Aborting.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// write LEDGER.json
// ---------------------------------------------------------------------------
mkdirSync(resolve(ROOT, "compare"), { recursive: true });
writeFileSync(
  resolve(ROOT, "compare/LEDGER.json"),
  JSON.stringify(
    {
      totalTargetElements,
      exact,
      tolerated: { total: tolerated, mechanical: toleratedMechanical, blessed: toleratedBlessed, byRule: toleratedByRule },
      gap: { total: gap, byClass: gapByClass },
      reconciles,
      perType,
      viewerPairs,
      viewerOurOnly,
      ruleHits,
      overCap,
      provisional: provisional.map((b) => b.id),
      toleratedDeltas: ledger.tolerated,
      gaps: ledger.gaps,
    },
    null,
    2,
  ),
);
console.log("\nWrote compare/LEDGER.json");

// ---------------------------------------------------------------------------
// write TOLERANCES.md
// ---------------------------------------------------------------------------
const md: string[] = [];
md.push("# TOLERANCES — approved tolerance registry & 3-way reconciliation ledger");
md.push("");
md.push(`Generated by \`compare/classify.ts\` on ${new Date().toISOString().slice(0, 10)} from the APPROVED rules in`);
md.push("`compare/tolerances.ts`. Every target element is classified EXACT / TOLERATED / GAP. A delta is");
md.push("TOLERATED **only** if an approved rule's predicate VERIFIED the justified divergence from data");
md.push("(mechanical) or both values equal a pinned pair (blessed). Nothing is blindly ignored: every");
md.push("tolerated delta cites its rule + evidence, and every blessing pins exact values.");
md.push("");
md.push("## Headline");
md.push("");
md.push(`- **total target elements**: ${totalTargetElements}`);
md.push(`  - **EXACT**: ${exact}`);
md.push(`  - **TOLERATED**: ${tolerated} — mechanical ${toleratedMechanical} + blessed ${toleratedBlessed}`);
md.push(`  - **GAP (true residual)**: ${gap} — ${Object.entries(gapByClass).map(([k, v]) => `${k} ${v}`).join(", ")}`);
md.push(`- **reconciliation**: ${exact} + ${tolerated} + ${gap} = ${sum} ${reconciles ? "✓ (= total)" : "✗ FAIL"}`);
md.push("");
md.push("The residual GAP set is now ONLY true gaps: coding-gaps stay in their dedicated bucket");
md.push("(tolerated-as-known, never matched), real-gaps are genuine omissions/changes, and `unsure`");
md.push("are display/ref divergences no approved predicate could verify. No path was blanket-ignored.");
md.push("");
md.push("## Round-2a note — Class-4 server artifacts reclassified as reviewed tolerances");
md.push("");
md.push("Round-2a (TODO #6) added NARROW, verifying Class-4 rules so server-minted artifacts are");
md.push("TOLERATED-with-evidence rather than raw GAPs: `server-artifact-meta-versionid` /");
md.push("`server-artifact-meta-lastupdated` (structural-variant; server-only, no faithful EHI");
md.push("source), the cosmetic encounter participant/location `.display` labels (same entity, label");
md.push("is the Epic enc-type master we don't ship), and additional iso-ref opaque-id-by-natural-key");
md.push("rules. Baseline TOLERATED rose **582 → 731 (+149)** with GAP **−149**; each rule was");
md.push("adversarially checked to still GAP a same-shaped regression (wrong entity / changed value).");
md.push("The `tolerate-documentreference-content-attachment-binary` rule stays **pending TODO #1**");
md.push("(depends on Binary emission) and is in the dropped/never-applied list below until then.");
md.push("");

if (provisional.length) {
  md.push("## ⚠ HUMAN SIGN-OFF REQUIRED");
  md.push("");
  md.push("These BLESSED-VALUE rules are **provisional**: applied (and tolerating today) but a human must");
  md.push("co-sign before they are trusted. Each pins an exact (target, our) value pair; any drift resurfaces");
  md.push("as a GAP.");
  md.push("");
  md.push("| rule | scope | pinned target | pinned ours | hits | rationale |");
  md.push("|---|---|---|---|---:|---|");
  for (const b of provisional) {
    md.push(
      `| \`${b.id}\` | \`${b.scope}\` | \`${b.pinTargetValue}\` | \`${b.pinOurValue}\` | ${ruleHits[b.id]} | ${b.rationale.replace(/\|/g, "\\|").slice(0, 220)} |`,
    );
  }
  md.push("");
}

md.push("## Approved MECHANICAL rules");
md.push("");
md.push("Each carries a narrow VERIFYING predicate that re-derives the equivalence from data every run and");
md.push("still GAPs a same-shaped regression (a ref to a DIFFERENT entity, a CHANGED value).");
md.push("");
md.push("| rule | kind | scope | hits / cap | regression it still rejects |");
md.push("|---|---|---|---:|---|");
for (const r of MECHANICAL) {
  const cap = ruleHits[r.id] > r.hitCap ? `**${ruleHits[r.id]} / ${r.hitCap} ⚠**` : `${ruleHits[r.id]} / ${r.hitCap}`;
  md.push(`| \`${r.id}\` | ${r.kind} | \`${r.scope}\` | ${cap} | ${r.approval.rejectsRegression.replace(/\|/g, "\\|")} |`);
}
md.push("");
for (const r of MECHANICAL) {
  md.push(`### \`${r.id}\`  (${r.kind})`);
  md.push("");
  md.push(`- **scope**: \`${r.scope}\``);
  md.push(`- **tolerated hits**: ${ruleHits[r.id]} (cap ${r.hitCap})${ruleHits[r.id] > r.hitCap ? " ⚠ OVER CAP" : ""}`);
  md.push(`- **predicate**: ${r.predicate}`);
  md.push(`- **rationale**: ${r.rationale}`);
  md.push(`- **approval**: ${r.approval.status} by ${r.approval.reviewer} — ${r.approval.note}`);
  md.push(`- **regression still rejected**: ${r.approval.rejectsRegression}`);
  md.push("");
}

md.push("## Approved BLESSED-VALUE rules");
md.push("");
md.push("Pinned exact (target, our) pairs — tolerate ONLY that pair; any drift resurfaces as a GAP.");
md.push("");
md.push("| rule | scope | pinned target | pinned ours | signoff | status | hits | blessedBy |");
md.push("|---|---|---|---|---|---|---:|---|");
for (const b of BLESSED) {
  md.push(
    `| \`${b.id}\` | \`${b.scope}\` | \`${b.pinTargetValue}\` | \`${b.pinOurValue}\` | ${b.signoff} | ${b.approval.status} | ${ruleHits[b.id]} | ${b.blessedBy} |`,
  );
}
md.push("");
for (const b of BLESSED) {
  md.push(`### \`${b.id}\`  (blessed-value, ${b.signoff})`);
  md.push("");
  md.push(`- **scope**: \`${b.scope}\``);
  md.push(`- **pinned pair**: target \`${b.pinTargetValue}\` ↔ ours \`${b.pinOurValue}\``);
  md.push(`- **tolerated hits**: ${ruleHits[b.id]} (cap ${b.hitCap})`);
  md.push(`- **status**: ${b.approval.status}${b.signoff === "human-required" ? " — HUMAN SIGN-OFF REQUIRED" : ""}`);
  md.push(`- **rationale**: ${b.rationale}`);
  md.push(`- **approval**: ${b.approval.reviewer} — ${b.approval.note}`);
  md.push(`- **regression still rejected**: ${b.approval.rejectsRegression}`);
  md.push("");
}

md.push("## Dropped candidate rules (verdict REJECT — never applied)");
md.push("");
md.push("Recorded for audit. The divergences they targeted remain GAPs (no blind ignore).");
md.push("");
for (const d of DROPPED) {
  md.push(`- **\`${d.id}\`** — ${d.reason}`);
}
md.push("");

md.push("## Gap ledger (residual true gaps, by class)");
md.push("");
md.push("| class | count |");
md.push("|---|---:|");
for (const [k, v] of Object.entries(gapByClass).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
md.push("");
md.push("Top gap clusters (resourceType.path):");
md.push("");
const gapClusters = new Map<string, { cls: string; n: number; ex: string }>();
for (const g of ledger.gaps) {
  const k = `${g.rt}.${g.path}`;
  const e = gapClusters.get(k);
  if (e) e.n++;
  else gapClusters.set(k, { cls: g.cls, n: 1, ex: `tgt ${JSON.stringify(g.targetVal)} / our ${JSON.stringify(g.ourVal)}` });
}
md.push("| resourceType.path | class | count | example |");
md.push("|---|---|---:|---|");
for (const [k, v] of [...gapClusters.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40))
  md.push(`| \`${k}\` | ${v.cls} | ${v.n} | ${v.ex.replace(/\|/g, "\\|").slice(0, 80)} |`);
md.push("");

writeFileSync(resolve(ROOT, "compare/TOLERANCES.md"), md.join("\n"));
console.log("Wrote compare/TOLERANCES.md");
