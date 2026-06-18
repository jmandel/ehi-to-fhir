#!/usr/bin/env bun
/**
 * build-viewer.ts — build report/viewer/data.json, the data layer that powers the HTML report's
 * interactive comparison widget. DETERMINISTIC consumer of compare/LEDGER.json (which already carries
 * per-instance tgtId/ourId + rationale on every TOLERATED and GAP leaf, plus viewerPairs/viewerOurOnly)
 * and the raw resources in out-crosswalk/ (ours) + fhir-target/ (Epic's live-API reference target).
 *
 * Per-leaf disposition is read back from the trusted ledger (never re-derived), so the widget cannot
 * drift from the official EXACT/TOLERATED/GAP reconciliation. GAP rationale = tools/floor-audit.ts
 * verdict(); TOLERATED rationale = ledger evidence.
 *
 * Payload sections:
 *   summary       headline counts + per-type scorecard
 *   pairs[]       matched target↔ours, full both resources + every difference (TOLERATED/GAP) + rationale
 *   cantReproduce[]  target resources with NO ehi-derivable counterpart (whole-resource floor) + proof
 *   ourOnly[]     resources we emit beyond the target, within a target-matched type (extra coverage)
 *   newResources[]   resource TYPES we reconstructed from EHI with NO reference target at all
 *                    (Communication, ExplanationOfBenefit, Claim, ChargeItem, Invoice, Account,
 *                     PaymentReconciliation, CoverageEligibilityResponse, ServiceRequest, Binary)
 *   samples       curated per (type, subgroup) instance picks so the report can FEATURE examples
 *
 * Run after: EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-crosswalk
 *   bun tools/build-viewer.ts
 */
import { verdict } from "./floor-audit";
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const TARGET_DIR = resolve(ROOT, "fhir-target");
// Defaults = the canonical crosswalk view. Override (env) to build the honest "raw export only" view:
//   VIEWER_OUR=out  VIEWER_LEDGER=compare/LEDGER.json (a lean classify run)  VIEWER_DATA=report/viewer/data-lean.json
const OUR_DIR = resolve(ROOT, process.env.VIEWER_OUR || "out-crosswalk");
const OUT = resolve(ROOT, "report/viewer");
const DATA_OUT = resolve(ROOT, process.env.VIEWER_DATA || "report/viewer/data.json");
const L = JSON.parse(readFileSync(resolve(ROOT, process.env.VIEWER_LEDGER || "compare/LEDGER.json"), "utf8"));

// ---------------------------------------------------------------------------
// load + index resources
// ---------------------------------------------------------------------------
function indexDir(dir: string): Map<string, any> {
  const m = new Map<string, any>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "bundle.json") continue;
    try { const a = JSON.parse(readFileSync(resolve(dir, f), "utf8")); if (Array.isArray(a)) for (const r of a) if (r?.resourceType && r?.id) m.set(`${r.resourceType}/${r.id}`, r); } catch {}
  }
  return m;
}
const TGT = indexDir(TARGET_DIR);
const OUR = indexDir(OUR_DIR);
const typesIn = (dir: string) =>
  [...new Set(readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "bundle.json").map((f) => f.replace(/\.json$/, "").replace(/__.*$/, "")))].sort();
const targetTypes = typesIn(TARGET_DIR);
const ourTypes = typesIn(OUR_DIR);
const newTypes = ourTypes.filter((t) => !targetTypes.includes(t)); // includes Binary + billing + Communication

// ---------------------------------------------------------------------------
// subgroup — the clinically/financially meaningful axis within a type, so the report can sample
// each subgroup directly (per the brief). Plain-language labels where possible.
// ---------------------------------------------------------------------------
const f1 = (...xs: any[]) => xs.find((x) => x !== undefined && x !== null && x !== "");
function subgroup(rt: string, r: any): string {
  const catCode = r?.category?.[0]?.coding?.[0]?.code;
  const catText = r?.category?.[0]?.text || r?.category?.[0]?.coding?.[0]?.display;
  switch (rt) {
    case "Observation": case "DiagnosticReport": return String(f1(catText, catCode, "other"));
    case "Condition": return String(f1(catText, catCode, "other"));
    case "Encounter": return String(f1(r?.class?.display, r?.class?.code, "other"));
    case "DocumentReference": return String(f1(r?.type?.text, r?.type?.coding?.[0]?.display, catText, "other"));
    case "MedicationRequest": return String(f1(r?.intent, "order"));
    case "Immunization": return String(f1(r?.status, "completed"));
    case "Communication": return String(f1(r?.category?.[0]?.text, r?.category?.[0]?.coding?.[0]?.code, "message"));
    default: return "(all)";
  }
}

// ---------------------------------------------------------------------------
// per-instance deltas from the ledger (TOLERATED + GAP), keyed by owning resource
// ---------------------------------------------------------------------------
const kindOfRule = (id: string): string =>
  id.startsWith("iso-ref") ? "isomorphic-ref"
  : /encounter-class-standard/.test(id) ? "standard-vs-proprietary-code"
  : /state-name-expansion/.test(id) ? "cosmetic-display"
  : id.startsWith("cosmetic") ? "cosmetic-display"
  : id.startsWith("minute-rounded") ? "minute-rounded-instant"
  : id.startsWith("tolerate") ? "structural-variant"
  : /version-server-stamp/.test(id) ? "server-version-stamp"
  : /blessed/.test(id) ? "blessed-value" : "other";

// Map a gap's floor-proof rationale to ONE reader-facing family id (keys content.ts COULDNT_FAMILIES).
// Order matters: first match wins, most-specific first.
function floorFamily(note: string, path: string, ourVal?: any): string {
  const n = (note || "").toLowerCase();
  const emitted = !(ourVal === null || ourVal === undefined);
  // when WE emitted a value (just not byte-identical / not auto-verified), that's a deliberate
  // source-faithful divergence — never a "couldn't reproduce". Family records why it diverges.
  if (emitted) {
    if (/privacy|redact|masked initials|phi/.test(n)) return "redacted-or-masked";
    if (/comparator artifact|duplicate-per-ser/.test(n)) return "comparison-artifact";
    if (/instant|rounding|study-time|byte-matching|byte-reproducible|last_final/.test(n)) return "different-precision";
    if (/opaque|bijection|fail-closed|non-bijective|same-entity unprovable/.test(n)) return "different-reference";
    return "we-chose-a-truthful-value"; // truthful name/drug/label/standard-code-choice etc.
  }
  // ourVal absent — a genuine "couldn't reproduce"
  if (/grouper|container|no standalone ehi row|hasmember|panel-grouper/.test(n)) return "structural-grouper";
  if (/privacy|redact|masked initials|phi/.test(n)) return "redacted-or-masked";
  if (/comparator artifact|duplicate-per-ser/.test(n)) return "comparison-artifact";
  if (/no dx_id->snomed|no dx_id→snomed|->snomed|→snomed|crosswalk|loinc.*absent|snomed.*absent|\.96|flowsheet/.test(n)) return "no-code-crosswalk";
  if (/dict|enc_type_c|visit-type|role.*not exported|template|provider-mnemonic|allergen-type|numeric epic code|only .*_c_name|epic-oid/.test(n)) return "withheld-dictionary";
  if (/server|narrative|userselected|publishing value|api-only|curat|self-?stamp|version/.test(n)) return "server-decoration";
  if (/instant|rounding|study-time|byte-matching|byte-reproducible|last_final/.test(n)) return "not-byte-reproducible";
  if (/opaque|bijection|fail-closed|non-bijective|same-entity unprovable/.test(n)) return "unmatchable-reference";
  return "not-in-export"; // appointment slot end, accidentrelated boolean, absent columns, "blank beats invention", etc.
}
type Delta = { path: string; status: "TOLERATED" | "GAP"; targetVal: any; ourVal: any; rationale: string; ruleId?: string; kind?: string; cls?: string; family?: string; emitted?: boolean };
const tolByKey = new Map<string, Delta[]>(), gapByKey = new Map<string, Delta[]>();
const push = (m: Map<string, Delta[]>, k: string, d: Delta) => (m.get(k) ?? m.set(k, []).get(k)!).push(d);
for (const t of L.toleratedDeltas || []) if (t.tgtId) push(tolByKey, `${t.rt}/${t.tgtId}`, { path: t.path, status: "TOLERATED", targetVal: t.targetVal, ourVal: t.ourVal, rationale: t.evidence, ruleId: t.ruleId, kind: kindOfRule(t.ruleId) });
for (const g of L.gaps || []) { if (g.path === "(whole resource)" || !g.tgtId) continue; const note = verdict(g)[1]; const ov = g.ourVal ?? null; push(gapByKey, `${g.rt}/${g.tgtId}`, { path: g.path, status: "GAP", targetVal: g.targetVal, ourVal: ov, rationale: note, cls: g.cls, family: floorFamily(note, g.path, ov), emitted: ov !== null }); }

// leaf count (EXACT denominator), excluding resourceType + top-level id
function leafCount(o: any, k = "", top = true): number {
  if (o === null || o === undefined) return 0;
  if (Array.isArray(o)) return o.reduce((s, v) => s + leafCount(v, k, false), 0);
  if (typeof o === "object") return Object.entries(o).reduce((s, [kk, v]) => s + (kk === "resourceType" || (top && kk === "id") ? 0 : leafCount(v, kk, false)), 0);
  return 1;
}

// ---------------------------------------------------------------------------
// PAIRS — side-by-side with full diff
// ---------------------------------------------------------------------------
const pairs = (L.viewerPairs || []).map((p: any) => {
  const target = TGT.get(`${p.rt}/${p.tgtId}`), our = OUR.get(`${p.rt}/${p.ourId}`);
  const tol = tolByKey.get(`${p.rt}/${p.tgtId}`) || [], gap = gapByKey.get(`${p.rt}/${p.tgtId}`) || [];
  const deltas = [...tol, ...gap].sort((a, b) => a.path.localeCompare(b.path));
  const leaves = target ? leafCount(target) : 0;
  return { rt: p.rt, subgroup: target ? subgroup(p.rt, target) : "(all)", key: p.key, tgtId: p.tgtId, ourId: p.ourId, target, ours: our, deltas, exact: Math.max(0, leaves - deltas.length), tol: tol.length, gap: gap.length };
});

// CANT-REPRODUCE — unaligned target resources (whole-resource floor). Includes the rare degenerate
// target with no id/natural key (kept, not dropped, so the count reconciles with the ledger).
const cantReproduce = (L.gaps || []).filter((g: any) => g.path === "(whole resource)").map((g: any) => {
  const target = g.tgtId ? TGT.get(`${g.rt}/${g.tgtId}`) : null;
  const note = verdict(g)[1];
  return { rt: g.rt, key: g.targetVal || "(no identifying content)", tgtId: g.tgtId || null, subgroup: target ? subgroup(g.rt, target) : "(all)", target: target || null, reason: note, family: floorFamily(note, "(whole resource)", null) };
});

// OUR-ONLY — within target-matched types, ours has no aligned target (extra coverage, ref-integrity)
const ourOnly = (L.viewerOurOnly || []).map((o: any) => { const our = OUR.get(`${o.rt}/${o.ourId}`); return { rt: o.rt, key: o.key, ourId: o.ourId, subgroup: our ? subgroup(o.rt, our) : "(all)", our }; });

// NEW RESOURCES — types reconstructed from EHI with NO reference target at all
const previewBinary = (r: any) => { if (r.resourceType !== "Binary") return r; const c = { ...r }; if (typeof c.data === "string" && c.data.length > 240) c.data = c.data.slice(0, 160) + `…[${c.data.length} base64 chars omitted]`; return c; };
const newResources: any[] = [];
for (const rt of newTypes) for (const [k, r] of OUR) if (k.startsWith(rt + "/")) newResources.push({ rt, id: r.id, subgroup: subgroup(rt, r), our: previewBinary(r) });

// ---------------------------------------------------------------------------
// curated samples per (type, subgroup): the most-divergent + the cleanest, so the report shows both
// "this maps perfectly" and "here is exactly where it can't".
// ---------------------------------------------------------------------------
function samplePairs() {
  const out: Record<string, any[]> = {};
  const bySub = new Map<string, any[]>();
  for (const p of pairs) (bySub.get(`${p.rt}|${p.subgroup}`) ?? bySub.set(`${p.rt}|${p.subgroup}`, []).get(`${p.rt}|${p.subgroup}`)!).push(p);
  for (const [k, ps] of bySub) {
    const [rt, sub] = k.split("|");
    const sorted = [...ps].sort((a, b) => b.tol + b.gap - (a.tol + a.gap));
    const most = sorted[0], least = sorted[sorted.length - 1];
    (out[rt] ??= []).push({ subgroup: sub, count: ps.length, mostDivergent: { tgtId: most.tgtId, why: `${most.tol} tolerated / ${most.gap} gap` }, cleanest: { tgtId: least.tgtId, why: `${least.exact} exact / ${least.gap} gap` } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHI redaction for PUBLICATION (the report ships our own record; this only protects the patient's
// direct identifiers from being revealed by the un-redacted Epic reference-target side).
// Our generator already replaces the patient's phone/email/street/MRN/contact with [REDACTED-*] tokens.
// Epic's target side is NOT redacted, so without this the comparison would show the real value (the
// "preimage") next to our token. We derive the preimage SET from the data (NO hardcoded patient
// values — anti-cheat): the target's string values sitting at the exact paths where our Patient carries
// a token. Then scrub those values from the published payload only (local fhir-target stays intact).
// Exact-leaf match (+ street substrings for composite address text) so reference strings like
// "Patient/pat-<id>" are never touched.
function leavesByPath(r: any): Map<string, any[]> {
  const m = new Map<string, any[]>();
  (function go(p: string, n: any) {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) return n.forEach((x) => go(p + "[]", x));
    if (typeof n === "object") return Object.entries(n).forEach(([k, v]) => go(p ? `${p}.${k}` : k, v));
    (m.get(p) ?? m.set(p, []).get(p)!).push(n);
  })("", r);
  return m;
}
function buildRedactor(pairs: any[]) {
  const pp = pairs.find((p) => p.rt === "Patient");
  const exact = new Set<string>();      // exact leaf values to redact (phone/email/MRN/contact name)
  const subs = new Set<string>();       // street substrings to scrub inside composite address text
  if (pp?.ours && pp?.target) {
    const oByPath = leavesByPath(pp.ours), tByPath = leavesByPath(pp.target);
    for (const [path, ovals] of oByPath) {
      if (!ovals.some((v) => typeof v === "string" && /^\[REDACTED/.test(v))) continue; // path our side redacts
      for (const tv of tByPath.get(path) || []) {
        if (typeof tv !== "string" || !tv.trim() || /^\[REDACTED/.test(tv)) continue;
        if (/[\r\n]/.test(tv)) continue;     // composite (address.text) — handled via street substrings
        exact.add(tv.trim());
        if (/line\[\]$/.test(path)) subs.add(tv.trim()); // street line -> also scrub inside composites
      }
    }
  }
  const subList = [...subs].sort((a, b) => b.length - a.length);
  const TOKEN = "[REDACTED]";
  const redactStr = (s: string): string => {
    if (exact.has(s.trim())) return TOKEN;
    let out = s;
    for (const p of subList) if (out.includes(p)) out = out.split(p).join(TOKEN);
    return out;
  };
  const walk = (n: any): any =>
    typeof n === "string" ? redactStr(n)
    : Array.isArray(n) ? n.map(walk)
    : n && typeof n === "object" ? Object.fromEntries(Object.keys(n).map((k) => [k, walk(n[k])])) : n;
  return { walk, n: exact.size + subs.size };
}
const redactor = buildRedactor(pairs);

// ── Bridge-contribution decomposition (canonical build only) ────────────────
// Splits the reproduced leaves into "the raw export already had it" vs "the terminology bridge
// recovered it", over the same canonical denominator. Only meaningful for the crosswalk build, and
// only when the lean output (out/) is present to compare against.
function computeDecomposition(): any {
  const LEAN_DIR = resolve(ROOT, "out");
  if (!OUR_DIR.endsWith("out-crosswalk") || !existsSync(LEAN_DIR)) return null;
  const LEAN = indexDir(LEAN_DIR);
  const lv = (r: any) => { const m = new Map<string, any[]>(); (function go(p: string, n: any) { if (n == null) return; if (Array.isArray(n)) return n.forEach((x) => go(p + "[]", x)); if (typeof n === "object") return Object.entries(n).forEach(([k, v]) => go(p ? `${p}.${k}` : k, v)); (m.get(p) ?? m.set(p, []).get(p)!).push(n); })("", r); return m; };
  const disp = new Map<string, { g: Map<string, any[]>; t: Map<string, any[]> }>();
  const sl = (k: string) => disp.get(k) ?? disp.set(k, { g: new Map(), t: new Map() }).get(k)!;
  const pu = (m: Map<string, any[]>, p: string, v: any) => (m.get(p) ?? m.set(p, []).get(p)!).push(v);
  for (const g of L.gaps) if (g.tgtId && g.path !== "(whole resource)") pu(sl(`${g.rt}/${g.tgtId}`).g, g.path, { tv: g.targetVal, ov: g.ourVal });
  for (const t of L.toleratedDeltas) if (t.tgtId) pu(sl(`${t.rt}/${t.tgtId}`).t, t.path, { tv: t.targetVal, ov: t.ourVal });
  const c = { exportIdentical: 0, exportEquivalent: 0, bridgeVocab: 0, bridgeIdentifier: 0, bridgeOther: 0, different: 0, absent: 0 };
  const isCoding = (p: string) => /coding\[\]\.(system|code|display)$|\.code$|\.system$/.test(p) || /vaccineCode|valueCodeableConcept/.test(p);
  const isIdent = (p: string) => /identifier/.test(p);
  const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  for (const vp of L.viewerPairs as any[]) {
    const target = TGT.get(`${vp.rt}/${vp.tgtId}`); if (!target) continue;
    const lean = LEAN.get(`${vp.rt}/${vp.ourId}`); const ll = lean ? lv(lean) : new Map();
    const has = (p: string, v: any) => (ll.get(p) || []).some((x: any) => eq(x, v));
    const d = disp.get(`${vp.rt}/${vp.tgtId}`) || { g: new Map(), t: new Map() };
    for (const [path, vals] of lv(target)) {
      if (path === "id") continue;
      const pool = [...vals], rm = (v: any) => { const i = pool.findIndex((x) => eq(x, v)); if (i >= 0) pool.splice(i, 1); };
      for (const g of d.g.get(path) || []) { rm(g.tv); (g.ov === null || g.ov === undefined) ? c.absent++ : c.different++; }
      for (const t of d.t.get(path) || []) { rm(t.tv); has(path, t.ov) ? c.exportEquivalent++ : (isCoding(path) ? c.bridgeVocab++ : isIdent(path) ? c.bridgeIdentifier++ : c.bridgeOther++); }
      for (const ev of pool) { has(path, ev) ? c.exportIdentical++ : (isCoding(path) ? c.bridgeVocab++ : isIdent(path) ? c.bridgeIdentifier++ : c.bridgeOther++); }
    }
  }
  for (const g of L.gaps) if (g.path === "(whole resource)") c.absent++;
  return c;
}
const decomposition = computeDecomposition();

const payload = redactor.walk({
  generatedFrom: "compare/LEDGER.json (crosswalk, attachments embedded, SmartData excluded)",
  summary: { exact: L.exact, tolerated: L.tolerated?.total ?? 0, gap: L.gap?.total ?? 0, total: L.totalTargetElements, reconciles: L.reconciles, gapByClass: L.gap?.byClass || {}, perType: L.perType || {}, decomposition },
  pairs, cantReproduce, ourOnly, newResources, samples: samplePairs(),
});

mkdirSync(OUT, { recursive: true });
writeFileSync(DATA_OUT, JSON.stringify(payload));

// reconcile check: per-type leaf dispositions must match the ledger perType
let warn = 0;
const sumBy = (arr: any[], pick: (p: any) => number) => arr.reduce((s, p) => s + pick(p), 0);
console.log("=== build-viewer → report/viewer/data.json ===");
console.log(`pairs ${pairs.length} | cant-reproduce ${cantReproduce.length} | our-only ${ourOnly.length} | new-type instances ${newResources.length}`);
console.log(`new resource TYPES: ${newTypes.join(", ")}`);
console.log(`tolerated leaves in pairs ${sumBy(pairs, (p) => p.tol)} (ledger ${L.tolerated.total}) | gap-in-pairs ${sumBy(pairs, (p) => p.gap)} + whole-resource ${cantReproduce.length} (ledger gap ${L.gap.total})`);
const kb = Math.round(JSON.stringify(payload).length / 1024);
console.log(`PHI redaction: ${redactor.n} patient preimage value(s) scrubbed from the published payload`);
console.log(`data.json ${kb} KB`);
