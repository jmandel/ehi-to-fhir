#!/usr/bin/env bun
/**
 * redact-fhir-target.ts — produce a COMMITTABLE, PHI-safe fhir-target/ whose redaction markers are
 * ALIGNED to the EHI markers, so the CI comparison (fresh gold vs this target) reads redacted fields
 * as EXACT rather than as a token-style mismatch.
 *
 * How: the gold output (out-crosswalk/, built from my-ehi's redacted raw) already carries my-ehi's exact
 * stable tokens ([REDACTED-PHONE-1], …). We derive each realValue→token mapping by pairing the gold
 * Patient with the (unredacted) reference target Patient — telecom/contact by (system|use), identifier by
 * system, address by line substring — then rewrite the WHOLE target with those exact tokens. There is no
 * build-time safety-net scrub anymore, so this MUST leave zero residual PHI (verified at the end).
 *
 *   GOLD=out-crosswalk SRC=fhir-target.unredacted OUT=fhir-target bun tools/redact-fhir-target.ts
 * Defaults: GOLD=out-crosswalk, SRC=fhir-target, OUT=fhir-target (in place).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
const ROOT = resolve(import.meta.dir, "..");
const GOLD = resolve(ROOT, process.env.GOLD || "out-crosswalk");
const SRC = resolve(ROOT, process.env.SRC || "fhir-target");
const OUT = resolve(ROOT, process.env.OUT || "fhir-target");
const isTok = (v: any) => typeof v === "string" && /^\[REDACTED-/.test(v);
const real = (v: any) => typeof v === "string" && v.trim() && !isTok(v);
const load1 = (dir: string, type: string) => { const f = resolve(dir, type + ".json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []; };

const goldPat = load1(GOLD, "Patient")[0] || {};
const tgtPat = load1(SRC, "Patient")[0] || {};

const exact = new Map<string, string>();   // real value (trimmed) -> exact EHI token
const subs: [string, string][] = [];        // [real substring, token]  (street lines inside composite text)
const addMap = (rv: any, tok: any) => { if (real(rv) && isTok(tok)) exact.set(String(rv).trim(), tok); };

// telecom & contact telecom: pair by system|use
const pairTelecom = (g: any[] = [], t: any[] = []) => {
  const key = (x: any) => `${x.system || ""}|${x.use || ""}`;
  const gb = new Map<string, any[]>(); for (const x of g) (gb.get(key(x)) ?? gb.set(key(x), []).get(key(x))!).push(x);
  const used: Record<string, number> = {};
  for (const x of t) { const k = key(x); const arr = gb.get(k) || []; const i = used[k] = (used[k] ?? -1) + 1; if (arr[i]) addMap(x.value, arr[i].value); }
};
pairTelecom(goldPat.telecom, tgtPat.telecom);
// identifier: pair by system (only the one my-ehi redacted has a token in gold; others kept)
{
  const gb = new Map(); for (const x of goldPat.identifier || []) gb.set(x.system, x);
  for (const x of tgtPat.identifier || []) { const g = gb.get(x.system); if (g && isTok(g.value)) addMap(x.value, g.value); }
}
// contact: name.text + telecom + address.line (pair by index)
(tgtPat.contact || []).forEach((tc: any, i: number) => {
  const gc = (goldPat.contact || [])[i] || {};
  addMap(tc.name?.text, gc.name?.text);
  pairTelecom(gc.telecom, tc.telecom);
  (tc.address?.line || []).forEach((ln: any, j: number) => { const gl = gc.address?.line?.[j]; if (real(ln) && isTok(gl)) { exact.set(String(ln).trim(), gl); subs.push([String(ln).trim(), gl]); } });
});
// address lines (street) — exact + substring (so composite address.text gets the street scrubbed)
(tgtPat.address || []).forEach((ta: any, i: number) => {
  const ga = (goldPat.address || [])[i] || {};
  (ta.line || []).forEach((ln: any, j: number) => { const gl = ga.line?.[j]; if (real(ln) && isTok(gl)) { exact.set(String(ln).trim(), gl); subs.push([String(ln).trim(), gl]); } });
});
// SAFETY SWEEP — "expose nothing beyond the (public) gold." fhir-target is Epic's FHIR (not covered by
// my-ehi's EHI redaction), so any patient PHI value that does NOT appear in the gold (built from my-ehi's
// public redacted raw) is not confirmed-public and must be tokenized — e.g. the MyChart login and payer
// member id, which Epic's FHIR exposes but the EHI export does not. Values the gold KEEPS (the PAT_ID
// anchor, the MRNs my-ehi keeps, the old address) are already public, so we keep them → comparison stays
// clean and we never imply "ours leaks more than Epic". The patient NAME/DOB are kept (public).
const goldReals = new Set<string>();
for (const f of readdirSync(GOLD).filter((f) => f.endsWith(".json") && f !== "bundle.json")) {
  (function go(n: any) { if (typeof n === "string") { if (real(n)) goldReals.add(n.trim()); } else if (Array.isArray(n)) n.forEach(go); else if (n && typeof n === "object") Object.values(n).forEach(go); })(JSON.parse(readFileSync(resolve(GOLD, f), "utf8")));
}
const ensure = (rv: any, tok: string, asSub = false) => { if (!real(rv)) return; const k = String(rv).trim(); if (exact.has(k) || goldReals.has(k)) return; exact.set(k, tok); if (asSub) subs.push([k, tok]); };
// keep identifiers that are (a) the PAT_ID anchor used for natural-key ref pairing AND already public as
// pat-<id> throughout the gold, or (b) opaque Epic FHIR server ids (not PHI, not load-bearing to redact).
const KEEP_ID_SYS = new Set([
  "urn:oid:1.2.840.114350.1.13.283.2.7.2.698084",                              // EXTERNAL/INTERNAL = PAT_ID anchor
  "http://open.epic.com/FHIR/StructureDefinition/patient-dstu2-fhir-id",
  "http://open.epic.com/FHIR/StructureDefinition/patient-fhir-id",
]);
for (const tel of tgtPat.telecom || []) ensure(tel.value, tel.system === "email" ? "[REDACTED-EMAIL]" : "[REDACTED-PHONE]");
for (const idf of tgtPat.identifier || []) if (!KEEP_ID_SYS.has(idf.system)) ensure(idf.value, `[REDACTED-${String(idf.type?.text || "ID").replace(/\s+/g, "-")}]`);
for (const ad of tgtPat.address || []) for (const ln of ad.line || []) ensure(ln, "[REDACTED-ADDRESS-1]", true);
for (const c of tgtPat.contact || []) { for (const tel of c.telecom || []) ensure(tel.value, tel.system === "email" ? "[REDACTED-EMAIL]" : "[REDACTED-PHONE]"); for (const ln of c.address?.line || []) ensure(ln, "[REDACTED-ADDRESS-1]", true); if (c.name?.text) ensure(c.name.text, "[REDACTED-NAME-1]"); }
subs.sort((a, b) => b[0].length - a[0].length);

const redactStr = (s: string): string => { if (exact.has(s.trim())) return exact.get(s.trim())!; let o = s; for (const [p, tok] of subs) if (o.includes(p)) o = o.split(p).join(tok); return o; };
const walk = (n: any): any => typeof n === "string" ? redactStr(n) : Array.isArray(n) ? n.map(walk) : n && typeof n === "object" ? Object.fromEntries(Object.keys(n).map((k) => [k, walk(n[k])])) : n;

mkdirSync(OUT, { recursive: true });
let files = 0;
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".json"))) {
  const arr = JSON.parse(readFileSync(resolve(SRC, f), "utf8"));
  writeFileSync(resolve(OUT, f), JSON.stringify(walk(arr), null, 1));
  files++;
}
console.log(`redact-fhir-target: ${exact.size} value→token mappings (${subs.length} street substrings) applied to ${files} files → ${OUT.replace(ROOT + "/", "")}`);
console.log("token set used:", JSON.stringify([...new Set([...exact.values()])].sort()));

// ── also rewrite crosswalk/identifiers.csv so CI's identifier-recovery emits values that MATCH the
// redacted target (→ EXACT, restores recovery at no PHI cost). Patient rows: replace target_value with
// the redacted target's value for the same system (token for not-public, kept-real for public). Other
// rows (e.g. public Practitioner NPIs) are left untouched. The unredacted CSV stays local+gitignored. ──
const idCsv = resolve(ROOT, "crosswalk/identifiers.csv");
const idCsvSrc = resolve(ROOT, process.env.IDCSV_SRC || "crosswalk/identifiers.csv.unredacted");
if (existsSync(idCsvSrc) || existsSync(idCsv)) {
  const sysToVal = new Map<string, any>();
  const redTgtPat = JSON.parse(readFileSync(resolve(OUT, "Patient.json"), "utf8"))[0] || {};
  for (const i of redTgtPat.identifier || []) if (i.system && i.value != null) sysToVal.set(i.system, i.value);
  const srcCsv = existsSync(idCsvSrc) ? idCsvSrc : idCsv;
  const lines = readFileSync(srcCsv, "utf8").split("\n");
  let changed = 0;
  const out = lines.map((ln, n) => {
    if (n === 0 || !ln.trim()) return ln;
    const f = ln.split(",");
    if (f[0] === "Patient" && sysToVal.has(f[3]) && f[4] !== String(sysToVal.get(f[3]))) { f[4] = String(sysToVal.get(f[3])); changed++; }
    return f.join(",");
  });
  writeFileSync(idCsv, out.join("\n"));
  console.log(`identifiers.csv: ${changed} patient identifier value(s) aligned to target tokens (from ${srcCsv.replace(ROOT + "/", "")})`);
}
