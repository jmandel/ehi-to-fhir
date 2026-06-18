#!/usr/bin/env bun
/**
 * _selfcheck_tol.ts — INJECTION self-check for the new/affected tolerance families.
 * Imports the REAL rule verify() predicates from tolerances.ts and feeds each a
 * (genuine-pair -> TOLERATE) and an injected (wrong-value / wrong-entity -> GAP) ctx.
 * Asserts the genuine pair tolerates AND the injected regression returns null (GAP).
 * Pure in-memory; reads no out/ files (so it is independent of the embed build).
 */
import { MECHANICAL, type Rule } from "./tolerances";
import type { ClassifyContext } from "./classify-lib";

const ruleById = (id: string): Rule => {
  const r = MECHANICAL.find((m) => m.id === id);
  if (!r) throw new Error("rule not found: " + id);
  return r;
};

// Minimal ctx builder. `siblings` is a per-side map {relPath -> value}; `index` resolves refs.
function mkCtx(opts: {
  path: string;
  targetVal: any;
  ourVal: any;
  tSib?: Record<string, any>;
  oSib?: Record<string, any>;
  tRoot?: any;
  oRoot?: any;
  index?: Record<string, any>;
}): ClassifyContext {
  const idx = opts.index || {};
  return {
    resourceType: opts.path.split(".")[0],
    path: opts.path,
    targetVal: opts.targetVal,
    ourVal: opts.ourVal,
    resolve: (ref) => idx[ref] || null,
    targetAt: (rel) => (opts.tSib || {})[rel.split(".").pop()!] ?? (opts.tSib || {})[rel],
    ourAt: (rel) => (opts.oSib || {})[rel.split(".").pop()!] ?? (opts.oSib || {})[rel],
    targetRoot: opts.tRoot,
    ourRoot: opts.oRoot,
    department: () => null,
    locationNamesUnique: () => true,
    specimenAccessionUnique: () => true,
    basedOnOrderMate: () => null,
    encounterStdClass: () => null,
  } as ClassifyContext;
}

let pass = 0, fail = 0;
function expectTol(label: string, r: Rule, ctx: ClassifyContext) {
  const ev = (r as any).verify(ctx);
  if (ev) { pass++; console.log(`  TOLERATE ok  [${r.id}] ${label} :: ${String(ev).slice(0, 80)}`); }
  else { fail++; console.log(`  TOLERATE FAIL[${r.id}] ${label} :: expected tolerate, got GAP`); }
}
function expectGap(label: string, r: Rule, ctx: ClassifyContext) {
  const ev = (r as any).verify(ctx);
  if (!ev) { pass++; console.log(`  GAP ok       [${r.id}] ${label}`); }
  else { fail++; console.log(`  GAP FAIL     [${r.id}] ${label} :: wrongly tolerated: ${String(ev).slice(0, 80)}`); }
}

const REASON_SYS = "urn:oid:1.2.840.114350.1.13.283.2.7.2.728286";

// ============================================================================
// Family A.1 — cosmetic-case coding.display
// ============================================================================
console.log("Family A.1 — cosmetic-case-encounter-reasoncode-coding-display");
{
  const r = ruleById("cosmetic-case-encounter-reasoncode-coding-display");
  // GENUINE: same {system,code}, case-only display diff -> TOLERATE
  expectTol("Annual Exam vs ANNUAL EXAM, same code 83", r,
    mkCtx({ path: "Encounter.reasonCode[].coding[].display", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { system: REASON_SYS, code: "83" }, oSib: { system: REASON_SYS, code: "83" } }));
  // INJECTED wrong-VALUE: genuinely different letters (not just case) -> GAP
  expectGap("different letters (Annual Exam vs ESTABLISH CARE), same code", r,
    mkCtx({ path: "Encounter.reasonCode[].coding[].display", targetVal: "Annual Exam", ourVal: "ESTABLISH CARE",
      tSib: { system: REASON_SYS, code: "83" }, oSib: { system: REASON_SYS, code: "83" } }));
  // INJECTED wrong-ENTITY: same words, but DIFFERENT concept code -> GAP
  expectGap("same words, different concept code (83 vs 42)", r,
    mkCtx({ path: "Encounter.reasonCode[].coding[].display", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { system: REASON_SYS, code: "83" }, oSib: { system: REASON_SYS, code: "42" } }));
  // INJECTED wrong-ENTITY: same words+code, but DIFFERENT system -> GAP
  expectGap("same words, different system", r,
    mkCtx({ path: "Encounter.reasonCode[].coding[].display", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { system: REASON_SYS, code: "83" }, oSib: { system: "urn:oid:9.9.9", code: "83" } }));
  // INJECTED: no concept anchor at all (no code) -> GAP (don't tolerate a bare word match)
  expectGap("no code anchor", r,
    mkCtx({ path: "Encounter.reasonCode[].coding[].display", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: {}, oSib: {} }));
}

// ============================================================================
// Family A.2 — cosmetic-case CodeableConcept.text
// ============================================================================
console.log("Family A.2 — cosmetic-case-encounter-reasoncode-text");
{
  const r = ruleById("cosmetic-case-encounter-reasoncode-text");
  const codingAnnual = [{ system: REASON_SYS, code: "83", display: "ANNUAL EXAM" }];
  const codingAnnualTgt = [{ system: REASON_SYS, code: "83", display: "Annual Exam" }];
  const codingEstablish = [{ system: REASON_SYS, code: "42", display: "ESTABLISH CARE" }];
  // GENUINE: same concept SET, case-only text -> TOLERATE
  expectTol("Annual Exam vs ANNUAL EXAM, same coding set {83}", r,
    mkCtx({ path: "Encounter.reasonCode[].text", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { coding: codingAnnualTgt }, oSib: { coding: codingAnnual } }));
  // INJECTED wrong-VALUE: different letters -> GAP
  expectGap("different letters text, same set", r,
    mkCtx({ path: "Encounter.reasonCode[].text", targetVal: "Annual Exam", ourVal: "ESTABLISH CARE",
      tSib: { coding: codingAnnualTgt }, oSib: { coding: codingAnnualTgt } }));
  // INJECTED wrong-ENTITY: same words, DIFFERENT coding concept set -> GAP
  expectGap("same words, different coding set ({83} vs {42})", r,
    mkCtx({ path: "Encounter.reasonCode[].text", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { coding: codingAnnualTgt }, oSib: { coding: codingEstablish } }));
  // INJECTED: no coded concept to anchor the text -> GAP
  expectGap("no coding to anchor", r,
    mkCtx({ path: "Encounter.reasonCode[].text", targetVal: "Annual Exam", ourVal: "ANNUAL EXAM",
      tSib: { coding: [] }, oSib: { coding: [] } }));
}

// ============================================================================
// Family C — masked requester/recorder/performer/author display (existing rules,
// shared verifyMaskedNameDisplayBySer). Confirm a same-shaped regression GAPs.
// ============================================================================
console.log("Family C — masked display by SER (existing rules, confirm regression GAPs)");
{
  const SER = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99";
  // Both resolve to SER 554385 and share the MULTI-CHAR surname "Provider"; target carries Epic's
  // privacy-masked given ("G") while ours carries the fuller given.
  const pracTgt = { resourceType: "Practitioner", id: "p-tgt",
    identifier: [{ system: SER, value: "554385" }], name: [{ family: "Provider", given: ["G"] }] };
  const pracOur = { resourceType: "Practitioner", id: "p-our",
    identifier: [{ system: SER, value: "554385" }], name: [{ family: "Provider", given: ["Gerald"] }] };
  // a DIFFERENT real clinician our-side (different SER + different name)
  const pracOther = { resourceType: "Practitioner", id: "p-oth",
    identifier: [{ system: SER, value: "999999" }], name: [{ family: "Dhillon", given: ["Puneet"] }] };
  const idx: Record<string, any> = {
    "Practitioner/p-tgt": pracTgt, "Practitioner/p-our": pracOur, "Practitioner/p-oth": pracOther,
  };
  for (const id of ["cosmetic-medicationrequest-requester-display",
                    "cosmetic-medicationrequest-recorder-display",
                    "cosmetic-observation-performer-display",
                    "cosmetic-documentreference-author-display"]) {
    const r = ruleById(id);
    const refRel = r.scope.replace(/\.display$/, ".reference").replace(/^[^.]+\./, "");
    const refTail = refRel.split(".").pop()!;
    // GENUINE: same SER, masked vs fuller given, both name-forms of their own resolved Practitioner
    expectTol("G Provider (masked) vs Gerald Provider, same SER 554385", r,
      mkCtx({ path: r.scope, targetVal: "G Provider", ourVal: "Gerald Provider",
        tSib: { [refTail]: "Practitioner/p-tgt" }, oSib: { [refTail]: "Practitioner/p-our" }, index: idx }));
    // INJECTED wrong-ENTITY: sibling ref re-pointed to a DIFFERENT SER/clinician -> GAP
    expectGap("sibling ref to a different SER entity", r,
      mkCtx({ path: r.scope, targetVal: "G", ourVal: "Puneet Dhillon",
        tSib: { [refTail]: "Practitioner/p-tgt" }, oSib: { [refTail]: "Practitioner/p-oth" }, index: idx }));
    // INJECTED wrong-name-on-correct-ref: correct SER ref (Provider) but OUR display swapped to a
    // DIFFERENT real clinician's name ("Puneet Dhillon") -> not a name-form of our resolved Provider -> GAP
    expectGap("wrong clinician name on a correct SER ref", r,
      mkCtx({ path: r.scope, targetVal: "G Provider", ourVal: "Puneet Dhillon",
        tSib: { [refTail]: "Practitioner/p-tgt" }, oSib: { [refTail]: "Practitioner/p-our" }, index: idx }));
  }
}

// ============================================================================
// Family B — attachment url + contentType (existing rules). Confirm the same-shaped
// regression (a DIFFERENT note's anchor) GAPs. Uses the DOCUMENT_ID note anchor.
// ============================================================================
console.log("Family B — attachment url + contentType (existing rules, confirm different-note GAPs)");
{
  const DOC = "urn:oid:1.2.840.114350.1.13.283.2.7.2.727879";
  // content bytes -> sha1 hex + base64 (so url 'Binary/bin-<hex>' matches slot hash <b64>)
  const crypto = require("crypto");
  const bytes = Buffer.from("the exact note bytes");
  const sha1 = crypto.createHash("sha1").update(bytes).digest();
  const hex = sha1.toString("hex");
  const b64 = sha1.toString("base64");
  const ourUrl = `Binary/bin-${hex}`;
  const tgtUrl = "Binary/eYZ.h-kKopaqueEpicId";
  const ourBinary = { resourceType: "Binary", id: `bin-${hex}` };
  const idx: Record<string, any> = { [ourUrl]: ourBinary };
  const drSame = (side: "t" | "o") => ({ resourceType: "DocumentReference", id: side === "t" ? "dr-t" : "dr-o",
    identifier: [{ system: DOC, value: "NOTE-123" }] });
  const drDiff = { resourceType: "DocumentReference", id: "dr-x", identifier: [{ system: DOC, value: "NOTE-999" }] };

  // ---- url rule ----
  const urlRule = ruleById("tolerate-documentreference-content-attachment-binary");
  expectTol("our content-addressed Binary url, same DOCUMENT_ID NOTE-123", urlRule,
    mkCtx({ path: urlRule.scope, targetVal: tgtUrl, ourVal: ourUrl,
      oSib: { hash: b64 }, tRoot: drSame("t"), oRoot: drSame("o"), index: idx }));
  // INJECTED wrong-ENTITY: same url/hash but parent DocumentReference is a DIFFERENT note -> GAP
  expectGap("attachment on a DIFFERENT note (DOCUMENT_ID NOTE-999)", urlRule,
    mkCtx({ path: urlRule.scope, targetVal: tgtUrl, ourVal: ourUrl,
      oSib: { hash: b64 }, tRoot: drSame("t"), oRoot: drDiff, index: idx }));
  // INJECTED wrong-VALUE: url points at a Binary whose sha1 != slot hash (a different payload) -> GAP
  expectGap("url sha1 != slot hash (different payload)", urlRule,
    mkCtx({ path: urlRule.scope, targetVal: tgtUrl, ourVal: `Binary/bin-${"0".repeat(40)}`,
      oSib: { hash: b64 }, tRoot: drSame("t"), oRoot: drSame("o"),
      index: { [`Binary/bin-${"0".repeat(40)}`]: { resourceType: "Binary", id: "bin-" + "0".repeat(40) } } }));

  // ---- contentType rule ----
  const ctRule = ruleById("tolerate-documentreference-content-attachment-contenttype");
  expectTol("text/rtf vs text/html, same DOCUMENT_ID, Binary url siblings", ctRule,
    mkCtx({ path: ctRule.scope, targetVal: "text/html", ourVal: "text/rtf",
      tSib: { url: tgtUrl }, oSib: { url: ourUrl }, tRoot: drSame("t"), oRoot: drSame("o") }));
  // INJECTED wrong-ENTITY: different note anchor -> GAP
  expectGap("contentType on a DIFFERENT note", ctRule,
    mkCtx({ path: ctRule.scope, targetVal: "text/html", ourVal: "text/rtf",
      tSib: { url: tgtUrl }, oSib: { url: ourUrl }, tRoot: drSame("t"), oRoot: drDiff }));
  // INJECTED wrong-VALUE: a NON-note media type -> GAP
  expectGap("non-note media type (application/pdf)", ctRule,
    mkCtx({ path: ctRule.scope, targetVal: "application/pdf", ourVal: "text/rtf",
      tSib: { url: tgtUrl }, oSib: { url: ourUrl }, tRoot: drSame("t"), oRoot: drSame("o") }));
}

console.log(`\nSELF-CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
