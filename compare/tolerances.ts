#!/usr/bin/env bun
/**
 * tolerances.ts — the TOLERANCE REGISTRY of APPROVED rules ONLY.
 *
 * This is the single source of truth for which target/our divergences are TOLERATED
 * (and why) vs. left as a GAP. It is consumed by compare/classify.ts to produce the
 * 3-way ledger (EXACT / TOLERATED / GAP) over every target element.
 *
 * Provenance: candidate rules were surveyed by compare/propose.ts, then adversarially
 * REVIEWED. This file integrates ONLY the rules whose review verdict was approve / narrow
 * (with the review's TIGHTENED predicate applied). Rules whose verdict was REJECT are
 * DROPPED entirely (recorded in `dropped` below for audit, never applied).
 *
 * INVARIANTS enforced by the consumer (classify.ts), guaranteed by this registry's shape:
 *  - Reconciliation: exact + tolerated + gap = total target elements. Nothing silently dropped.
 *  - Fail-safe: a delta is TOLERATED only if it matches an APPROVED rule whose predicate
 *    VERIFIES the divergence is the justified kind from data; otherwise it is a GAP.
 *  - Predicates are NARROW + VERIFYING, never path-blanket ignores: each still flags a
 *    same-shaped regression (a ref to a DIFFERENT entity, a CHANGED value) as a GAP.
 *  - Full attribution: every tolerated delta records its rule id + the matched evidence.
 *  - coding-gap stays its OWN gap bucket — tolerated-as-known, never "match".
 *
 * TWO TIERS:
 *  - MECHANICAL: a `verify(ctx)` predicate re-checks the divergence from data every run.
 *  - BLESSED-VALUE: pins BOTH the exact target value AND our exact value at a path; tolerates
 *    ONLY that exact (pinTargetValue, pinOurValue) pair. Any drift on either side -> GAP.
 *    Judgment-heavy blessings carry signoff:"human-required" and status:"provisional" until
 *    a human co-signs (still APPLIED while provisional, but clearly flagged).
 */

import { norm, normName, nameFormsOf, type ClassifyContext } from "./classify-lib";

// --- system OIDs (Epic-local, verified present on both sides) ------------------
export const OID_PAT_ID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.698084"; // PATIENT.PAT_ID (EXTERNAL)
export const OID_CSN = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8"; // Encounter CSN
export const OID_SER = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99"; // CCPROVID / SER

// =============================================================================
// Rule types
// =============================================================================
export type Approval = {
  status: "approved" | "provisional";
  reviewer: string;
  note: string; // reviewer-note: why approved
  rejectsRegression: string; // the same-shaped regression the predicate provably still GAPs
};

export type MechanicalRule = {
  id: string;
  tier: "mechanical";
  kind: "isomorphic-ref" | "specificity-ref" | "cosmetic-display" | "cosmetic-case" | "structural-variant";
  scope: string; // resourceType.path the rule governs
  predicate: string; // human-readable narrowed predicate
  rationale: string;
  approval: Approval;
  hitCap: number; // upper bound on tolerated hits; exceeding it is FLAGGED (drift signal)
  /**
   * appliesWhenOurAbsent: when true, this rule is ALSO consulted in the consumer's "missing" branch
   * (target carries the leaf, OUR side omits it). For these rules ctx.ourVal is null and the verify
   * MUST establish the "our side legitimately absent" equivalence from the ROOTS/siblings (it cannot
   * compare a paired our value because there is none). Default/absent => false: the rule is only tried
   * on the normal CHANGED branch (both sides present). Narrow by design: a structural artifact our
   * faithful export does not author (e.g. a server-stamped ValueSet .version) is the only justified use.
   */
  appliesWhenOurAbsent?: boolean;
  /**
   * verify: returns matched-evidence string to TOLERATE, or null to leave as GAP.
   * MUST be narrow+verifying: it re-derives the equivalence from data and returns null
   * for any same-shaped regression.
   */
  verify: (ctx: ClassifyContext) => string | null;
};

export type BlessedRule = {
  id: string;
  tier: "blessed";
  kind: "blessed-value";
  scope: string;
  pinTargetValue: string;
  pinOurValue: string;
  rationale: string;
  blessedBy: string;
  approval: Approval; // status:"provisional" while awaiting human co-sign
  signoff: "agent" | "human-required";
  hitCap: number;
};

export type Rule = MechanicalRule | BlessedRule;

// =============================================================================
// Shared verifying helpers (each re-derives equivalence from data)
// =============================================================================

// Resolve a "Type/id" reference on a given side to its resource.
const resolveRef = (ctx: ClassifyContext, ref: any, side: "tgt" | "our") =>
  typeof ref === "string" ? ctx.resolve(ref, side) : null;

// Patient PAT_ID natural key on a resolved Patient resource (whitespace-normalized).
function patIdKey(res: any): string | null {
  if (!res || res.resourceType !== "Patient") return null;
  const id = (res.identifier || []).find((i: any) => i.system === OID_PAT_ID && i.value);
  return id ? norm(id.value) : null;
}

// Strict SER (CCPROVID under .99) on a resolved Practitioner; require 5-7 digits, exactly one.
function serKey(res: any): string | null {
  if (!res || res.resourceType !== "Practitioner") return null;
  const sers = (res.identifier || [])
    .filter((i: any) => i.system === OID_SER && i.value != null)
    .map((i: any) => String(i.value).trim())
    .filter((v: string) => /^\d{5,7}$/.test(v));
  const uniq = [...new Set(sers)];
  return uniq.length === 1 ? uniq[0] : null;
}

// Encounter CSN (under the CSN OID) on a resolved Encounter; require exactly one.
function csnKey(res: any): string | null {
  if (!res || res.resourceType !== "Encounter") return null;
  const csns = (res.identifier || [])
    .filter((i: any) => i.system === OID_CSN && i.value != null)
    .map((i: any) => String(i.value).trim())
    .filter(Boolean);
  const uniq = [...new Set(csns)];
  return uniq.length === 1 ? uniq[0] : null;
}

// Epic component-code OID (CLINICAL_CONCEPT / .768282) + Specimen accession OID. Both are carried
// byte-identically on BOTH exports and serve as the SAME-ENTITY natural key for the referenced
// Observation / Specimen (our synthetic id differs but this key matches iff it is the same entity).
export const OID_OBS_COMPONENT = "urn:oid:1.2.840.114350.1.13.283.2.7.2.768282"; // Observation component code
export const OID_SPEC_ACC = "urn:oid:1.2.840.114350.1.13.283.2.7.3.798268.320"; // Specimen accession
export const OID_DOC_ID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.727879"; // DocumentReference DOCUMENT_ID (note anchor)

// A "Binary/..." reference string (the only ref shape we tolerate for attachment.url).
function isBinaryRef(v: any): boolean {
  return typeof v === "string" && /^Binary\/.+/.test(v);
}

// Our Binary ids are CONTENT-ADDRESSED: "Binary/bin-<sha1hex>" where <sha1hex> is the sha1 of the
// exact note bytes, and the attachment slot ALSO carries that same digest as base64 in attachment.hash.
// So url-id == hex(base64-decode(hash)) proves the url points at the Binary holding EXACTLY the bytes
// this content slot declares. If the url is swapped to a different note's Binary (different content),
// the embedded sha1 no longer matches the slot hash -> the check fails -> GAP. Returns true iff they agree.
function ourBinaryUrlMatchesSlotHash(url: any, hashB64: any): boolean {
  if (typeof url !== "string" || typeof hashB64 !== "string") return false;
  const m = /^Binary\/bin-([0-9a-f]{40})$/.exec(url);
  if (!m) return false;
  let hex = "";
  try {
    hex = Buffer.from(hashB64, "base64").toString("hex");
  } catch {
    return false;
  }
  return hex.length === 40 && hex === m[1];
}

// DocumentReference DOCUMENT_ID natural key (identifier.value @ OID_DOC_ID): the note anchor carried
// byte-identically on both exports. Require exactly one (else ambiguous -> null).
function docIdKey(res: any): string | null {
  if (!res || res.resourceType !== "DocumentReference") return null;
  const vals = [
    ...new Set(
      (res.identifier || [])
        .filter((i: any) => i.system === OID_DOC_ID && i.value != null)
        .map((i: any) => String(i.value).trim())
        .filter(Boolean),
    ),
  ];
  return vals.length === 1 ? (vals[0] as string) : null;
}

// Effective instant of a resource (mirrors classify.ts alignment field precedence, Observation-relevant).
function effectiveKey(res: any): string {
  return res?.effectiveDateTime || res?.effectivePeriod?.start || "";
}

// Observation natural key on a resolved Observation: the SINGLE Epic component code (system
// OID_OBS_COMPONENT) + effective instant. Require exactly one such code (else ambiguous -> null).
// This is the shared, injective key for result[] Observations (verified unique per side, byte-equal
// across sides); plain code.text/LOINC are NOT symmetric across sides so they are not used.
function obsComponentKey(res: any): string | null {
  if (!res || res.resourceType !== "Observation") return null;
  const codes = [
    ...new Set(
      (res.code?.coding || [])
        .filter((c: any) => c.system === OID_OBS_COMPONENT && c.code != null)
        .map((c: any) => String(c.code).trim())
        .filter(Boolean),
    ),
  ];
  if (codes.length !== 1) return null;
  const eff = effectiveKey(res);
  return `${codes[0]}@${eff}`;
}

// Specimen accession natural key on a resolved Specimen: the SINGLE accession value (system
// OID_SPEC_ACC). Require exactly one (else null). NOTE: accession is NON-INJECTIVE (one accession
// can map to several distinct Specimens); callers MUST additionally fail-closed via
// ctx.specimenAccessionUnique so an ambiguous accession is never used to tolerate a re-point.
function specimenAccessionKey(res: any): string | null {
  if (!res || res.resourceType !== "Specimen") return null;
  const vals = [
    ...new Set(
      (res.identifier || [])
        .filter((i: any) => i.system === OID_SPEC_ACC && i.value != null)
        .map((i: any) => String(i.value).trim())
        .filter(Boolean),
    ),
  ];
  return vals.length === 1 ? (vals[0] as string) : null;
}

// Tokenize a display/name into a lowercased punctuation-stripped token set.
function tokens(s: any): string[] {
  return normName(s).split(/\s+/).filter(Boolean);
}

// Practitioner.name family+given token set (the resolved provider's own recorded name).
function practitionerNameTokens(res: any): Set<string> {
  const out = new Set<string>();
  for (const n of res?.name || []) {
    for (const t of tokens(n.family)) out.add(t);
    for (const g of n.given || []) for (const t of tokens(g)) out.add(t);
    for (const t of tokens(n.text)) out.add(t);
  }
  return out;
}

// Is the display string a name-form of the resolved Practitioner? (subset/superset of name tokens)
function displayMatchesPractitioner(display: any, res: any): boolean {
  const dt = tokens(display);
  if (!dt.length) return false;
  const nt = practitionerNameTokens(res);
  if (!nt.size) return false;
  // every display token must be a name token (subset) OR every name token a display token (superset)
  const subset = dt.every((t) => nt.has(t));
  const superset = [...nt].every((t) => dt.includes(t));
  return subset || superset;
}

// Token "name variant of each other" test: every token of the shorter set prefix-relates to
// some token of the longer set (Josh prefix-of Joshua). Rejects Smith/Robert/typo/XXXXX.
function nameVariantOfEachOther(a: any, b: any): boolean {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((s) => long.some((l) => l.startsWith(s) || s.startsWith(l)));
}

// Patient subject.display cosmetic check (shared by Obs/Condition/Encounter/DocRef).
// Tolerate ONLY when: (1) sibling subject.reference resolves to the same Patient PAT_ID on both
// sides AND (2) BOTH displays are recorded name-forms of OUR Patient resource (anti-wrong-person).
function patientSubjectDisplay(ctx: ClassifyContext, displayPath: string): string | null {
  const refPath = displayPath.replace(/\.display$/, ".reference");
  const tref = ctx.targetAt(refPath);
  const oref = ctx.ourAt(refPath);
  const tres = resolveRef(ctx, tref, "tgt");
  const ores = resolveRef(ctx, oref, "our");
  const tk = patIdKey(tres), ok = patIdKey(ores);
  if (!tk || !ok || tk !== ok) return null; // sibling ref not same Patient -> GAP
  // both displays must be recorded name forms of our Patient (pins to data, not the always-true ref)
  const forms = nameFormsOf(ores);
  const tD = norm(ctx.targetVal), oD = norm(ctx.ourVal);
  if (!forms.has(tD) || !forms.has(oD)) return null;
  return `same Patient (PAT_ID ${ok}); both displays are recorded name-forms ["${ctx.targetVal}","${ctx.ourVal}"]`;
}

// Shared verify for the Patient-subject iso-ref family: tolerate ONLY if BOTH refs resolve to a
// Patient and the PAT_ID natural keys are equal. Identical machinery to iso-ref-observation-subject;
// re-derived from data each run. Non-Patient / dangling / different-PAT_ID -> null (GAP).
const verifyPatientRefByPatId = (ctx: ClassifyContext): string | null => {
  const tk = patIdKey(resolveRef(ctx, ctx.targetVal, "tgt"));
  const ok = patIdKey(resolveRef(ctx, ctx.ourVal, "our"));
  return tk && ok && tk === ok ? `same Patient PAT_ID "${ok}"` : null;
};

// Shared verify for the Encounter-by-CSN iso-ref family: tolerate ONLY if BOTH refs resolve to an
// Encounter carrying exactly one CSN under OID_CSN and the CSNs are byte-equal. Identical machinery to
// iso-ref-observation-encounter-by-csn. Different CSN / dangling target / non-Encounter -> null (GAP).
const verifyEncounterRefByCsn = (ctx: ClassifyContext): string | null => {
  const tk = csnKey(resolveRef(ctx, ctx.targetVal, "tgt"));
  const ok = csnKey(resolveRef(ctx, ctx.ourVal, "our"));
  return tk && ok && tk === ok ? `same Encounter CSN "${ok}"` : null;
};

// Shared verify for the Practitioner-by-SER iso-ref family: strict .99 SER (/^\d{5,7}$/, exactly one
// per side) + MULTI-CHAR resolved-name corroboration (a shared single masked initial is NOT enough).
// Identical machinery to iso-ref-encounter-participant-by-ser. A same-SER twin with a different name,
// a loose-EXTPROVID digit match, a non-Practitioner, or a dangling ref -> null (GAP).
const verifyPractitionerRefBySer = (ctx: ClassifyContext): string | null => {
  const tres = resolveRef(ctx, ctx.targetVal, "tgt");
  const ores = resolveRef(ctx, ctx.ourVal, "our");
  const tk = serKey(tres), ok = serKey(ores);
  if (!tk || !ok || tk !== ok) return null;
  const tn = practitionerNameTokens(tres), on = practitionerNameTokens(ores);
  if (!tn.size || !on.size) return null;
  const shared = [...tn].some((t) => t.length >= 2 && on.has(t));
  return shared ? `same SER "${ok}" + corroborating multi-char name token` : null;
};

// =============================================================================
// Server-artifact (structural) tolerance: meta.versionId / meta.lastUpdated
// =============================================================================
// meta.versionId / meta.lastUpdated are SERVER-MINTED on read (the FHIR server stamps the resource
// version + load time); they are NOT part of the faithful EHI source. Per the deep-dive there is no
// EHI column that authors these, so they are tolerated as server-only — BUT narrowly:
//   - versionId: tolerated ONLY when the value is the literal "1" (an unversioned first-write stamp).
//     Any other versionId (a real edit history "2"/"3"...) is a divergence we did NOT author -> GAP.
//   - lastUpdated: tolerated ONLY when it parses as a valid instant (server load timestamp). A garbage
//     / non-instant value -> GAP. (We do not pin the instant: it legitimately varies per export run.)
// NOTE: in the CURRENT dataset NEITHER side emits meta at all, so these rules are ZERO-HIT today; they
// are pre-registered (narrow + verifying) so a future server-minted meta is reviewed, not blind-ignored.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// =============================================================================
// Family A — COSMETIC-DISPLAY for masked names (display where the SIBLING REFERENCE is
// already iso-tolerated to the SAME entity, and the display differs only by Epic's
// privacy-masking ("Mary S") vs our fuller EHI name ("SMITH, MARY B")).
// =============================================================================
// Shared verify for the SER-resolved masked-name display family. The companion iso-ref-*-by-ser
// rule already tolerates the SIBLING .reference (same strict-.99 SER + multi-char name corroboration);
// this rule governs the parallel .display. Tolerate ONLY when ALL hold:
//   (1) sibling .reference resolves on BOTH sides to a Practitioner carrying the SAME strict SER
//       (serKey: system .99, /^\d{5,7}$/, exactly one per side) — i.e. the SAME entity the iso-ref
//       rule already blessed; a ref to a different/absent SER -> GAP (display on a different entity);
//   (2) the SER-resolved Practitioners share a MULTI-CHARACTER name token (defeats a same-SER twin /
//       EXTPROVID collision, exactly as the iso-ref rule does);
//   (3) BOTH displays are recorded name-forms of THEIR OWN resolved Practitioner (per-side
//       displayMatchesPractitioner: target "Mary S" is a name-form of SER's masked name; our
//       "SMITH, MARY B" is a name-form of our fuller name). A name swapped onto a correct ref (a
//       DIFFERENT real clinician's name) is NOT a name-form of the resolved provider -> GAP.
// The sibling-ref path is derived from the leaf path by swapping the trailing ".display" -> ".reference".
const verifyMaskedNameDisplayBySer = (ctx: ClassifyContext): string | null => {
  const refPath = ctx.path.replace(/\.display$/, ".reference");
  const tres = resolveRef(ctx, ctx.targetAt(refPath), "tgt");
  const ores = resolveRef(ctx, ctx.ourAt(refPath), "our");
  const tk = serKey(tres), ok = serKey(ores);
  if (!tk || !ok || tk !== ok) return null; // sibling ref not the SAME SER entity -> GAP
  const tn = practitionerNameTokens(tres), on = practitionerNameTokens(ores);
  if (!tn.size || !on.size) return null;
  const shared = [...tn].some((t) => t.length >= 2 && on.has(t));
  if (!shared) return null; // same-SER twin / EXTPROVID collision -> GAP
  // per-side: each display must be a recorded name-form of ITS OWN resolved Practitioner.
  if (!displayMatchesPractitioner(ctx.targetVal, tres)) return null;
  if (!displayMatchesPractitioner(ctx.ourVal, ores)) return null;
  return `same SER "${ok}" (iso-tolerated ref); both displays are name-forms of the resolved Practitioner (privacy-mask "${ctx.targetVal}" vs fuller "${ctx.ourVal}")`;
};

// Shared verify for the Encounter-enc-type-label display family (Observation.encounter.display etc.):
// the sibling .encounter.reference is already CSN-iso-tolerated to the SAME Encounter, and the display
// differs only because Epic ships the GENERIC enc-type master label ("Office Visit") while we ship the
// specific visit/procedure label ("PR PREVENTIVE VISIT,EST,18-39") for the SAME contact. Tolerate ONLY
// when the sibling .reference resolves on BOTH sides to an Encounter carrying the SAME single CSN
// (csnKey) AND both displays are non-empty labels. The same-CSN sibling-ref check IS the anti-regression
// guard: a display on a DIFFERENT encounter requires a re-pointed reference (different CSN) -> GAP. A
// dangling/non-Encounter ref, or an empty display, -> GAP.
const verifyEncounterTypeLabelDisplay = (ctx: ClassifyContext): string | null => {
  const refPath = ctx.path.replace(/\.display$/, ".reference");
  const tk = csnKey(resolveRef(ctx, ctx.targetAt(refPath), "tgt"));
  const ok = csnKey(resolveRef(ctx, ctx.ourAt(refPath), "our"));
  if (!tk || !ok || tk !== ok) return null; // sibling ref not the SAME Encounter (CSN) -> GAP
  const tD = norm(ctx.targetVal), oD = norm(ctx.ourVal);
  if (!tD || !oD) return null; // an empty/absent label is not the enc-type-label artifact -> GAP
  return `same Encounter CSN "${ok}" (iso-tolerated ref); enc-type label "${ctx.targetVal}" (Epic master) vs "${ctx.ourVal}" (our visit label)`;
};

// =============================================================================
// NEW Family — COSMETIC-CASE for coding.display. Where our coding.display equals the target's
// CASE-INSENSITIVELY *and* the coding's {system,code} are byte-equal across sides (the SAME concept,
// e.g. Epic reason OID .728286 code "83"), the ONLY divergence is letter-casing ("ANNUAL EXAM" vs
// "Annual Exam"): Epic title-cases the master display while our EHI source ships it upper-case. This
// is a presentation-only difference of the SAME coded concept. NARROW + VERIFYING:
//   - the leaf owner is the coding object, so sibling {system,code} are read off the SAME coding;
//   - we require the displays to be EQUAL after norm() (lower+trim+collapse) — a display that differs
//     by actual LETTERS (not just case) is NOT case-equal -> null -> GAP;
//   - we require both system AND code byte-equal (norm) across sides — a display on a DIFFERENT
//     concept (different code, or absent code) -> null -> GAP, even if the words happen to match.
// =============================================================================
const verifyCosmeticCaseCodingDisplay = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null;
  if (!t.trim() || !o.trim()) return null; // an empty display is not the case-variant artifact
  if (norm(t) !== norm(o)) return null; // differs by actual letters, not just case -> GAP
  // sibling {system,code} on the SAME coding object must be byte-equal (same concept) on both sides.
  const tSys = norm(ctx.targetAt("system")), oSys = norm(ctx.ourAt("system"));
  const tCode = norm(ctx.targetAt("code")), oCode = norm(ctx.ourAt("code"));
  if (!tCode || tCode !== oCode) return null; // different/absent code -> different concept -> GAP
  if (tSys !== oSys) return null; // different code system -> GAP
  if (!tSys && !tCode) return null; // no concept anchor at all -> GAP (don't tolerate a bare word match)
  return `case-only display variant of the SAME concept {system "${ctx.targetAt("system")}", code "${ctx.targetAt("code")}"}: target "${t}" vs our "${o}"`;
};

// Companion for the CodeableConcept .text leaf (owner is the reasonCode/CodeableConcept object, whose
// sibling is the coding[] ARRAY). Tolerate the case-only text variant ONLY when (1) target/our text are
// EQUAL after norm() (case-only, not different letters) AND (2) the entry's coding {system,code} concept
// SET matches across sides — i.e. this CodeableConcept names the SAME coded concept(s), so its .text is
// the same concept's label re-cased. A text that differs by real letters, or a CodeableConcept whose
// coding concept set differs (a different reason), -> null -> GAP.
const codingConceptSet = (coding: any): string[] =>
  (Array.isArray(coding) ? coding : [])
    .map((c: any) => `${norm(c?.system)}|${norm(c?.code)}`)
    .filter((k: string) => k !== "|")
    .sort();
const verifyCosmeticCaseCodeableText = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null;
  if (!t.trim() || !o.trim()) return null;
  if (norm(t) !== norm(o)) return null; // differs by actual letters -> GAP
  const tSet = codingConceptSet(ctx.targetAt("coding"));
  const oSet = codingConceptSet(ctx.ourAt("coding"));
  if (!tSet.length || !oSet.length) return null; // no coded concept to anchor the text -> GAP
  if (tSet.join(",") !== oSet.join(",")) return null; // different concept set -> a different reason -> GAP
  return `case-only text variant of the SAME concept set [${tSet.join(", ")}]: target "${t}" vs our "${o}"`;
};

// =============================================================================
// NEW Family — COSMETIC-DISPLAY for coding.display (code-gated, ANY display variant).
// Broader than cosmetic-CASE: tolerate a coding.display difference of ANY wording (not just
// re-casing) PROVIDED the SAME coding object's {system,code} are byte-equal across sides.
// Per FHIR, coding.display is a NON-NORMATIVE human label for the authoritative {system,code};
// when the code matches exactly, two systems rendering it differently (e.g. SNOMED FSN
// "Postconcussion syndrome (disorder)" vs our shorter "Postconcussion Syndrome", or Epic master
// "Blood Pressure" vs our flowsheet name "BP" on the SAME OID+FLO_MEAS_ID code) is presentation,
// not a semantic gap. STILL VERIFYING: both displays must be present AND the sibling {system,code}
// on the SAME coding object byte-equal — a display on a DIFFERENT/absent code -> null -> GAP.
// (User-approved; the concept-pairing in classify.ts pairs the display to its own {system,code}
// owner, so this never compares displays across different concepts.)
// =============================================================================
const verifyCosmeticDisplayByCode = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null;
  if (!t.trim() || !o.trim()) return null; // a missing display is a real omission, not this artifact
  const tSys = norm(ctx.targetAt("system")), oSys = norm(ctx.ourAt("system"));
  const tCode = norm(ctx.targetAt("code")), oCode = norm(ctx.ourAt("code"));
  if (!tCode || tCode !== oCode) return null; // different/absent code -> different concept -> GAP
  if (tSys !== oSys) return null; // different code system -> GAP
  return `display variant of the SAME concept {system "${ctx.targetAt("system")}", code "${ctx.targetAt("code")}"}: target "${t}" vs our "${o}"`;
};

// =============================================================================
// NEW Family — ATTACHMENT iso-url + contentType (task B). The DocumentReference content[] attachment
// .url ("Binary/<our-sha1>" vs target "Binary/<Epic-opaque-id>") and .contentType (text/rtf vs
// text/html) for the SAME note are ALREADY governed by the approved
// tolerate-documentreference-content-attachment-binary (url, iso-ref-by-note-anchor: same DOCUMENT_ID
// + content-identity sha1==slot-hash) and tolerate-documentreference-content-attachment-contenttype
// rules (defined in MECHANICAL below). Both are gated on the SAME-note DOCUMENT_ID anchor, so an
// attachment on a DIFFERENT note still GAPs, and both depend on the --embed-attachments build (which
// materializes the Binary + the content[].attachment.url); under the lean build they are zero-hit.
// No new rule is registered here (re-registering the same scope would double-count) — instead the two
// rules' hit-caps are confirmed to total the ~84 task-B leaves (56 url + 28 contentType).
// =============================================================================

// =============================================================================
// Family B — MINUTE-PRECISION for instants. The EHI export ROUNDS *_DTTM source columns
// to the minute, so OUR instant carries ":00" seconds while the target keeps real seconds.
// =============================================================================
// Tolerate ONLY when ALL hold: (1) BOTH values are well-formed ISO instants; (2) they are byte-equal
// after TRUNCATING to the minute (same YYYY-MM-DDThh:mm and same timezone suffix); (3) OUR value is the
// ROUNDED form — its seconds component is exactly "00" — i.e. this is genuinely our minute-rounding, not
// some other coincidental same-minute pair. A different minute/hour/day, a different timezone, OUR value
// carrying non-zero seconds (a real second-level divergence that merely lands in the same minute), or a
// malformed instant -> GAP.
const minutePart = (s: string): string | null => {
  // returns "YYYY-MM-DDThh:mm" + tz-suffix, or null if not a well-formed second-precision instant
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  return m ? `${m[1]}${m[3]}` : null;
};
const secondsPart = (s: string): string | null => {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
  return m ? m[1] : null;
};
const verifyMinuteRoundedInstant = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null;
  const tm = minutePart(t), om = minutePart(o);
  if (!tm || !om || tm !== om) return null; // different minute/day/tz, or malformed -> GAP
  if (secondsPart(o) !== "00") return null; // ours is NOT the minute-rounded form -> GAP (genuine second diff)
  return `minute-rounded export: ours "${o}" (seconds rounded to :00) == target "${t}" truncated to the minute`;
};

// =============================================================================
// Family C — ENCOUNTER.CLASS structural-variant. Epic ships its PROPRIETARY local class
// (system .696784.13260, code "13"/"5"/"4" "Support OP Encounter"/"Appointment"/"HOV"); FHIR
// REQUIRES the standard v3-ActCode, which we DERIVE from the encounter's ADT patient class
// (ADT_PAT_CLASS_C_NAME) per the documented enum map. Tolerate the standard-vs-Epic-local class
// variant ONLY when OUR derived class is the CORRECT standard mapping of THIS encounter's ADT class.
// =============================================================================
export const SYS_EPIC_ENC_CLASS = "urn:oid:1.2.840.114350.1.72.1.7.7.10.696784.13260"; // Epic proprietary class
export const SYS_V3_ACTCODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
// The Epic-local class codes that denote an OUTPATIENT/AMBULATORY concept (the only ones present in this
// specimen: 13 Support OP Encounter, 5 Appointment, 4 HOV). Listed so a future Epic-local INPATIENT code
// is NOT silently absorbed by this rule (it would fail the per-encounter standard-mapping equality below).
const EPIC_OUTPATIENT_CLASS_CODES = new Set(["13", "5", "4"]);
// Read this Encounter's single CSN off the resolved/owning resource root.
const encounterRootCsn = (root: any): string | null => csnKey(root);
// Shared verify for the Encounter.class.{system,code,display} structural variant. Tolerate ONLY when:
//   (1) the TARGET class.system is Epic's PROPRIETARY class OID (.13260) and OUR class.system is the
//       standard v3-ActCode — i.e. exactly the "standard vs Epic-local" axis (not some unrelated drift);
//   (2) the OWNING Encounter carries the SAME single CSN on both sides (this is the SAME contact);
//   (3) ctx.encounterStdClass(csn) — the standard v3-ActCode our buildClass WOULD derive from THIS
//       encounter's ADT_PAT_CLASS_C_NAME — equals OUR emitted class triple. So our class is the verified
//       correct standard mapping of the encounter's ADT class, re-derived from the source each run.
//   (4) the TARGET class.code is one of the known Epic-local OUTPATIENT class codes (anti-regression: a
//       future Epic-local INPATIENT code paired with our AMB would NOT be tolerated).
// A wrong derived class (ours != the ADT-derived standard mapping), a non-Epic-local target system, a
// non-v3-ActCode our system, an unknown Epic-local code, or a CSN mismatch -> GAP.
const verifyEncounterClassVariant = (ctx: ClassifyContext): string | null => {
  // Determine the standard class our builder derives for THIS encounter from its ADT class.
  const csn = encounterRootCsn(ctx.ourRoot) || encounterRootCsn(ctx.targetRoot);
  if (!csn) return null;
  const std = ctx.encounterStdClass(csn);
  if (!std) return null;
  // OUR Encounter.class triple (the root the leaf belongs to).
  const ourClass = ctx.ourRoot?.class;
  const tgtClass = ctx.targetRoot?.class;
  if (!ourClass || !tgtClass) return null;
  // (1) axis check: target Epic-local proprietary system, our standard v3-ActCode.
  if (norm(tgtClass.system) !== norm(SYS_EPIC_ENC_CLASS)) return null;
  if (norm(ourClass.system) !== norm(SYS_V3_ACTCODE)) return null;
  // (4) target code must be a known Epic-local OUTPATIENT class concept.
  if (!EPIC_OUTPATIENT_CLASS_CODES.has(String(tgtClass.code).trim())) return null;
  // (3) ours must EQUAL the ADT-derived standard mapping (system+code+display).
  if (
    norm(ourClass.system) !== norm(std.system) ||
    norm(ourClass.code) !== norm(std.code) ||
    norm(ourClass.display) !== norm(std.display)
  )
    return null;
  return `Encounter CSN "${csn}": our v3-ActCode ${std.code}/${std.display} is the correct ADT-class-derived standard mapping of Epic-local class "${tgtClass.code}" (${tgtClass.display})`;
};

// =============================================================================
// NEW Family (task A) — COSMETIC-CASE for free-text NAME / ADDRESS values that have NO code anchor.
// Patient.name.family/given, Organization.name, Organization.address[].line[]/.text differ between the
// exports ONLY by letter-CASE: Epic title-cases the master string ("Mac Associated Physicians") while
// our faithful EHI source ships it upper-case ("MAC ASSOCIATED PHYSICIANS"). These leaves carry no
// {system,code} sibling, so the ONLY admissible proof of "same value, re-cased" is norm-equality of
// the SAME element (norm = lower+trim+collapse). VERIFYING + STRICT:
//   - tolerate ONLY when norm(target) === norm(our) — a real-LETTER difference (truncation, abbrev,
//     a different word, a masked initial, a [REDACTED-*] PHI placeholder) is NOT norm-equal -> GAP;
//   - both sides must be non-empty strings (a present-vs-absent value is a real omission, not re-casing);
//   - we never pair across entities: the consumer matches this leaf to the SAME path on the aligned
//     resource, and we compare ctx.targetVal vs ctx.ourVal of that SAME element only.
// This deliberately does NOT cover Patient.address (its line/text are [REDACTED-ADDRESS-*] PHI, which is
// not norm-equal and stays a GAP/floor) nor masked-initial names ("Mary S" vs "Mary B Smith" — a real
// letter/token difference, not case -> GAP).
// =============================================================================
const verifyCosmeticCaseValue = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null; // a present-vs-absent value is not re-casing
  if (!t.trim() || !o.trim()) return null; // empty side -> real omission, not a case variant
  if (t === o) return null; // byte-identical would already be EXACT; nothing to tolerate
  if (norm(t) !== norm(o)) return null; // differs by ACTUAL letters (truncation/abbrev/different word/mask) -> GAP
  return `case-only variant of the SAME free-text value (norm-equal): target "${t}" vs our "${o}"`;
};

// =============================================================================
// NEW Family (task B) — USPS STATE NAME <-> 2-LETTER abbreviation expansion for address[].state.
// Epic ships the state as a 2-letter USPS code on one side and the full state NAME on the other
// (Organization.address[].state "WI" vs "Wisconsin"). These name the SAME state; the divergence is
// purely the abbreviation-vs-spelled-out form. VERIFYING via a FIXED USPS table (both directions):
//   - normalize both sides; tolerate ONLY when {target,our} is exactly a {2-letter code, full name}
//     pair for the SAME state in the table (either order) OR an identical-but-cased state name/code;
//   - a DIFFERENT state ("WI" vs "Minnesota", "WI" vs "IL") is NOT a matching pair -> GAP;
//   - an unknown/garbage value not in the table -> GAP.
// =============================================================================
// Fixed USPS 2-letter <-> state-name table (50 states + DC + common territories). Lowercased.
const USPS_STATE: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
  il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
  pr: "puerto rico", vi: "virgin islands", gu: "guam", as: "american samoa", mp: "northern mariana islands",
};
// canonical state key for a value: its 2-letter code (so "WI" and "Wisconsin" both map to "wi"); null if
// the value is neither a known code nor a known name.
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(USPS_STATE).map(([code, name]) => [name, code]),
);
function stateCanonical(v: any): string | null {
  const n = norm(v);
  if (!n) return null;
  if (USPS_STATE[n]) return n; // it is a 2-letter code
  if (NAME_TO_CODE[n]) return NAME_TO_CODE[n]; // it is a full name
  return null; // unknown -> not in table -> caller GAPs
}
const verifyStateNameExpansion = (ctx: ClassifyContext): string | null => {
  const t = ctx.targetVal, o = ctx.ourVal;
  if (typeof t !== "string" || typeof o !== "string") return null;
  if (!t.trim() || !o.trim()) return null;
  const tc = stateCanonical(t), oc = stateCanonical(o);
  if (!tc || !oc) return null; // a value not in the fixed USPS table -> GAP
  if (tc !== oc) return null; // names a DIFFERENT state -> GAP
  return `same USPS state "${tc.toUpperCase()}" (${USPS_STATE[tc]}): target "${t}" vs our "${o}"`;
};

// =============================================================================
// NEW Family (task C) — AllergyIntolerance clinicalStatus / verificationStatus coding .version "4.0.0".
// The target stamps the status Coding with version "4.0.0" (the FHIR R4 ValueSet version the SERVER
// applies when it expands the required allergy clinical-/verification-status value set); our faithful
// EHI export does NOT author a ValueSet version, so OUR side omits .version entirely. This is a
// server-stamped ValueSet-version artifact, tolerated ONLY for these two status scopes, ONLY when:
//   - OUR side is ABSENT (this is a structural our-side-absent rule; ctx.ourVal is null);
//   - the TARGET .version is exactly "4.0.0" (any other stamped version -> GAP, not blind-ignored);
//   - the OWNING coding's sibling {system,code} on the target name a real status concept under the
//     HL7 allergyintolerance status CodeSystem (so a .version stamped on some unrelated coding -> GAP);
//   - OUR resource carries the SAME status code under the SAME system (so the version is the only
//     divergence on a status WE DO emit — a missing/different status on our side -> GAP, not absorbed).
// Any non-"4.0.0" version, a different/absent sibling status concept, or our side missing that status
// entirely -> GAP.
// =============================================================================
const SYS_ALLERGY_CLINICAL = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";
const SYS_ALLERGY_VERIFICATION = "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";
// Does the resource's <statusField> (clinicalStatus|verificationStatus) carry a coding under the given
// system with the given code? (re-derives "we DO emit this same status" from our root, so the version is
// the ONLY divergence; a missing/different status on our side -> false -> GAP).
function statusHasCode(root: any, statusField: string, system: string, code: string): boolean {
  const cs = root?.[statusField]?.coding;
  if (!Array.isArray(cs)) return false;
  return cs.some((c: any) => norm(c?.system) === norm(system) && norm(c?.code) === norm(code));
}
const makeVerifyAllergyStatusVersion = (statusField: string, system: string) => (ctx: ClassifyContext): string | null => {
  if (ctx.ourVal != null) return null; // this rule governs ONLY the our-side-ABSENT version stamp
  if (String(ctx.targetVal) !== "4.0.0") return null; // any other server-stamped version -> GAP
  // sibling {system,code} on the SAME target coding must be a real status concept under THIS scope's system.
  const tSys = norm(ctx.targetAt("system")), tCode = norm(ctx.targetAt("code"));
  if (tSys !== norm(system) || !tCode) return null; // version stamped on a non-status / wrong-system coding -> GAP
  // OUR side must emit the SAME status code under the SAME system (so .version is the ONLY divergence).
  if (!statusHasCode(ctx.ourRoot, statusField, system, tCode)) return null;
  return `server-stamped ValueSet version "4.0.0" on the ${statusField} ${system}#${tCode} coding; our faithful export omits the ValueSet version (our side carries the same status code)`;
};

// =============================================================================
// APPROVED MECHANICAL RULES
// =============================================================================
export const MECHANICAL: MechanicalRule[] = [
  // ---- isomorphic-ref: Patient subject (Observation / Condition) ----
  {
    id: "iso-ref-observation-subject",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Observation.subject.reference",
    predicate:
      "Resolve target ref in the target entity index and our ref in our entity index. Tolerate ONLY if BOTH resolve to a Patient AND our resolved Patient's PAT_ID natural key (identifier.value @ " +
      OID_PAT_ID +
      ", whitespace-normalized) equals the target Patient's PAT_ID. Still GAPs: unresolvable/dangling ref, non-Patient type, or a Patient whose PAT_ID != target's. Does NOT cover subject.display.",
    rationale:
      "Synthetic id pat-Z7004242 vs target euBTtyZ... point at the same single Patient; only the minted id differs.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "MECHANICAL isomorphic-ref verified vs data; the PAT_ID key-equality clause (not bare is-a-Patient) carries the anti-regression guarantee. Predicate narrowed to compare the .698084 PAT_ID value explicitly.",
      rejectsRegression:
        "our subject.reference re-pointed to a non-Patient, a dangling ref, or a second Patient whose PAT_ID != target's -> GAP.",
    },
    hitCap: 120, // raised 60->120: round-4 category work aligned more Observations (verify-gated PAT_ID)
    verify: (ctx) => {
      const tk = patIdKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = patIdKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Patient PAT_ID "${ok}"` : null;
    },
  },
  {
    id: "iso-ref-condition-subject",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Condition.subject.reference",
    predicate:
      "Same PAT_ID-resolving check as iso-ref-observation-subject: tolerate ONLY if both refs resolve to a Patient sharing the target's PAT_ID natural key. Any other type/entity -> GAP.",
    rationale: "Same single Patient, differing synthetic id.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Two-sided natural-key-resolving check; not a type-only check. Rejects re-point to Encounter/Group or a different Patient.",
      rejectsRegression:
        "Condition.subject re-pointed to a different resourceType or a Patient with a different PAT_ID -> GAP.",
    },
    hitCap: 53,
    verify: (ctx) => {
      const tk = patIdKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = patIdKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Patient PAT_ID "${ok}"` : null;
    },
  },

  // ---- isomorphic-ref: Encounter by CSN (Observation / Condition) ----
  {
    id: "iso-ref-observation-encounter-by-csn",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Observation.encounter.reference",
    predicate:
      "Resolve both refs to their Encounter and read identifier.value @ " +
      OID_CSN +
      " (the CSN). Require exactly one CSN per side. Tolerate ONLY if the CSNs are byte-equal (no EHI->Epic CSN crosswalk exists, so the carried CSN is the sole proof). Re-point to an Encounter with a DIFFERENT CSN -> GAP.",
    rationale:
      "Matched Observations reference the same encounter; our enc-<CSN> id differs from target's opaque id but the CSN identifier.value matches.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Tolerate decision IS a byte-equal CSN compare bound to the resolved referent; stress-tested with an injected re-point (725327197 vs 1028743701) which correctly GAPped.",
      rejectsRegression: "encounter.reference re-pointed to an Encounter with a different CSN -> GAP.",
    },
    hitCap: 120, // raised 60->120: round-4 category work aligned more Observations (verify-gated CSN)
    verify: (ctx) => {
      const tk = csnKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = csnKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Encounter CSN "${ok}"` : null;
    },
  },
  {
    id: "iso-ref-condition-encounter-by-csn",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Condition.encounter.reference",
    predicate:
      "Resolve both Condition.encounter refs to their Encounter and compare CSN identifier.value @ " +
      OID_CSN +
      " (require exactly one per side). Tolerate ONLY if byte-equal. FAIL-SAFE: different CSNs (alignment artifacts like 1169847546 vs 1098684634) stay GAP.",
    rationale:
      "Synthetic ref id always differs but the OID-scoped CSN proves identity; same-CSN -> isomorphic, different-CSN -> GAP.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "CSN faithfully bound to the referent on both sides (0 mismatch on our enc-<CSN>==identifier; 0 mismatch target inline-vs-referenced). Real different-CSN cases correctly stay GAP.",
      rejectsRegression:
        "Condition.encounter re-pointed to a different encounter (different bound CSN), a CSN under a wrong system, or a missing inline identifier -> GAP.",
    },
    hitCap: 46,
    verify: (ctx) => {
      const tk = csnKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = csnKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Encounter CSN "${ok}"` : null;
    },
  },

  // ---- isomorphic-ref: Encounter participant by SER (narrowed) ----
  {
    id: "iso-ref-encounter-participant-by-ser",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Encounter.participant[].individual.reference",
    predicate:
      "Resolve BOTH refs to a Practitioner. Extract SER STRICTLY by system (identifier.value @ " +
      OID_SER +
      "), trimmed, /^\\d{5,7}$/, present on exactly one identifier per side (never a bare /\\d{4,7}/ regex over all identifiers — that also matches EXTPROVID .556 and INTERNAL .836982). Tolerate ONLY if: (a) SERs equal; AND (b) NATURAL-KEY CORROBORATION: the two resolved Practitioners share a MULTI-CHARACTER (>=2 char) name token (family or given). A single-letter token is rejected because Epic privacy-masks one name part to an initial, so a shared bare initial is NOT corroboration (a same-SER provider with a different family but the same masked initial would otherwise slip through). Missing/unequal SER, wrong-system SER, or only-an-initial-shared -> GAP.",
    rationale:
      "Practitioner SER (CCPROVID) is shared across both exports; only synthetic prac-<SER> vs opaque id differs. SER alone is non-injective (twins share a SER) so name corroboration is required.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: strict .99 system selection (not /\\d{4,7}/, which conflated SER with EXTPROVID 9005/3569) + MULTI-CHAR name-token corroboration to defeat same-SER twin re-points (ey81.. vs er.OePS.. both 144590) and cross-practitioner SER collisions. Adversarial review found the original 'share any token' clause tolerated a same-SER, different-family provider that coincidentally shared the privacy-masked initial; requiring a >=2-char shared token closes it (verified: all 27 real isomorphic pairs share a multi-char token).",
      rejectsRegression:
        "participant re-pointed to a same-SER twin Practitioner with a different name, or to a provider matched only on a loose EXTPROVID digit-string -> GAP.",
    },
    // cap = verified true cluster size in the FULL compare (54). The candidate-rule coversDeltas:32
    // was an under-counted survey estimate (Observation-only survey saw fewer participant entries);
    // all 54 hits verified as same-SER + name-corroborated tolerations across 14 distinct clinicians.
    hitCap: 54,
    verify: (ctx) => {
      const tres = resolveRef(ctx, ctx.targetVal, "tgt");
      const ores = resolveRef(ctx, ctx.ourVal, "our");
      const tk = serKey(tres), ok = serKey(ores);
      if (!tk || !ok || tk !== ok) return null;
      // corroborate by resolved Practitioner name (family + given), defeats twin re-point
      const tn = practitionerNameTokens(tres);
      const on = practitionerNameTokens(ores);
      if (!tn.size || !on.size) return null;
      // Require a shared MULTI-CHARACTER name token. Epic privacy-masks one name part to a single
      // initial (target "Dr. K Cahill" -> {dr,k,cahill}; "S"/"Smith"), so a single-letter token is
      // NOT corroboration: a same-SER provider with a different family but the same masked initial
      // would otherwise be wrongly tolerated. All 27 real isomorphic pairs share a >=2-char token.
      const shared = [...tn].some((t) => t.length >= 2 && on.has(t));
      return shared ? `same SER "${ok}" + corroborating multi-char name token` : null;
    },
  },

  // ---- isomorphic-ref: Encounter location by name (narrowed: fail-closed uniqueness) ----
  {
    id: "iso-ref-encounter-location-by-name",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Encounter.location[].location.reference",
    predicate:
      "Resolve both refs to a Location. (1) FAIL-CLOSED pre-check: across ALL resolvable Locations on each side, assert normalized Location.name is UNIQUE; if any normalized-name collision exists, this rule does NOT apply -> GAP (name can no longer serve as the natural key). (2) Tolerate ONLY if both refs resolve AND normalized resolved Location.name values are equal. (3) Unresolvable / cardinality mismatch -> GAP. Display divergence is out of scope (handled by cosmetic-encounter-location-display).",
    rationale:
      "Location is keyed by name; synthetic loc-<id> vs opaque id differs but the resolved place is the same. Name is a coalesced derived field (EXTERNAL_NAME ?? DEPARTMENT_NAME) so uniqueness must be asserted, not assumed.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: added fail-closed normalized-name uniqueness pre-check. The source already shows a near-collision (dept 101401044 vs 101401031 differing only by Epic 'ZZ' deactivation prefix); without the pre-check a future shared EXTERNAL_NAME would wrongly tolerate a re-point.",
      rejectsRegression:
        "re-point to a Location with a different name -> GAP; and if two departments ever share a name, the rule disables itself for that side -> GAP rather than a wrong tolerate.",
    },
    hitCap: 32,
    verify: (ctx) => {
      if (!ctx.locationNamesUnique("tgt") || !ctx.locationNamesUnique("our")) return null;
      const tres = resolveRef(ctx, ctx.targetVal, "tgt");
      const ores = resolveRef(ctx, ctx.ourVal, "our");
      const tn = norm(tres?.name), on = norm(ores?.name);
      if (!tn || !on || tn !== on) return null;
      return `same Location name "${on}" (names unique on both sides)`;
    },
  },

  // ---- isomorphic-ref: Patient subject — Encounter / DocumentReference (by PAT_ID) ----
  {
    id: "iso-ref-encounter-subject",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Encounter.subject.reference",
    predicate:
      "Resolve both refs; tolerate ONLY if BOTH resolve to a Patient whose PAT_ID natural key (identifier.value @ " +
      OID_PAT_ID +
      ", whitespace-normalized) is equal. Same predicate family as iso-ref-observation-subject. Non-Patient, dangling, or a different PAT_ID -> GAP.",
    rationale: "Synthetic pat-Z7004242 vs opaque euBTtyZ... point at the same single Patient; only the minted id differs.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Two-sided PAT_ID key-equality (not a bare is-a-Patient check); rejects a re-point to a second Patient or a non-Patient.",
      rejectsRegression: "Encounter.subject re-pointed to a non-Patient, a dangling ref, or a Patient with a different PAT_ID -> GAP.",
    },
    hitCap: 32,
    verify: (ctx) => {
      const tk = patIdKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = patIdKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Patient PAT_ID "${ok}"` : null;
    },
  },
  {
    id: "iso-ref-documentreference-subject",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "DocumentReference.subject.reference",
    predicate:
      "Resolve both refs; tolerate ONLY if BOTH resolve to a Patient sharing the target's PAT_ID natural key (@ " +
      OID_PAT_ID +
      "). EHI has other humans (DOC_LINKED_PATS, FAMILY_HX); a ref to a different Patient (mis-filed chart) -> GAP.",
    rationale: "Same single Patient; differing synthetic id.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "PAT_ID key-equality; the chart contains other persons, so the two-sided key compare (not type-only) is what rejects a wrong-person re-point.",
      rejectsRegression: "DocumentReference.subject re-pointed to a different Patient or a non-Patient -> GAP.",
    },
    // round-7: cap 28 -> 30. The r7 documentreference worker surfaced more real HNO_PLAIN_TEXT-backed
    // DocRefs (44 -> 51 emitted); each adds a subject ref that passes the SAME two-sided PAT_ID
    // key-equality verify (verify() below returns null unless both sides resolve to the same PAT_ID).
    // Every one of the 30 hits is verify-gated; the bump tracks legitimate new resources, not drift.
    hitCap: 30,
    verify: (ctx) => {
      const tk = patIdKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = patIdKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Patient PAT_ID "${ok}"` : null;
    },
  },

  // ---- isomorphic-ref: Patient subject — extended family (by PAT_ID) ----
  // Same two-sided PAT_ID key-equality machinery as iso-ref-observation-subject, applied to every other
  // element that points at the patient. The chart contains exactly one Patient per side, so the guarantee
  // is the SAME as the approved subject rules: a re-point to a non-Patient, a dangling ref, or a Patient
  // with a different PAT_ID still GAPs. Each scope is type-indexed; verify re-derives the key from data.
  ...(
    [
      ["Immunization.patient.reference", 19],
      ["MedicationRequest.subject.reference", 18],
      ["DiagnosticReport.subject.reference", 9],
      ["Specimen.subject.reference", 9],
      ["AllergyIntolerance.patient.reference", 4],
      ["CarePlan.subject.reference", 1],
      ["Coverage.subscriber.reference", 1],
      ["Coverage.beneficiary.reference", 1],
      ["Goal.subject.reference", 1],
    ] as const
  ).map(
    ([scope, cap]): MechanicalRule => ({
      id: "iso-ref-" + scope.replace(/\[\]/g, "").replace(/\./g, "-").replace(/-reference$/, "").toLowerCase() + "-by-patid",
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Resolve both refs; tolerate ONLY if BOTH resolve to a Patient whose PAT_ID natural key (identifier.value @ " +
        OID_PAT_ID +
        ", whitespace-normalized) is equal. Same predicate family as iso-ref-observation-subject. Non-Patient, dangling, or a different PAT_ID -> GAP.",
      rationale:
        "Synthetic pat-Z7004242 vs opaque target id point at the same single Patient; only the minted id differs. The chart carries other humans (DOC_LINKED_PATS / FAMILY_HX), so the two-sided key compare (not a bare is-a-Patient check) is what rejects a wrong-person re-point.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Extends the approved Patient-subject PAT_ID family to a same-shaped scope; verify is the shared verifyPatientRefByPatId (two-sided .698084 key-equality). Verified all hits resolve to PAT_ID Z7004242 on both sides; injected a non-Patient re-point which correctly GAPped.",
        rejectsRegression:
          scope + " re-pointed to a non-Patient, a dangling ref, or a Patient with a different PAT_ID -> GAP.",
      },
      hitCap: cap,
      verify: verifyPatientRefByPatId,
    }),
  ),

  // ---- isomorphic-ref: Encounter by CSN — extended family ----
  // Same byte-equal CSN-on-resolved-Encounter machinery as iso-ref-observation-encounter-by-csn. The
  // CSN is the sole same-entity proof (no EHI->Epic CSN crosswalk). A re-point to an Encounter with a
  // DIFFERENT CSN, a dangling target ref, or a non-Encounter still GAPs (verified: misaligned
  // MedicationRequest.encounter rows and the dangling Immunization.encounter target stay GAP).
  ...(
    [
      ["MedicationRequest.encounter.reference", 4],
      ["DiagnosticReport.encounter.reference", 9],
      ["Immunization.encounter.reference", 9],
    ] as const
  ).map(
    ([scope, cap]): MechanicalRule => ({
      id: "iso-ref-" + scope.replace(/\[\]/g, "").replace(/\./g, "-").replace(/-reference$/, "").toLowerCase() + "-by-csn",
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Resolve both refs to an Encounter and compare CSN identifier.value @ " +
        OID_CSN +
        " (require exactly one per side). Tolerate ONLY if byte-equal — same machinery as iso-ref-observation-encounter-by-csn. Re-point to an Encounter with a different CSN, a dangling ref, or a non-Encounter -> GAP.",
      rationale:
        "Same encounter; our enc-<CSN> id differs from the opaque target id but the OID-scoped CSN identifier matches. Same-CSN -> isomorphic, different/absent-CSN -> GAP.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Extends the approved CSN family to a same-shaped scope; verify is the shared verifyEncounterRefByCsn (byte-equal CSN bound to the resolved referent). Verified the misaligned rows (e.g. MedicationRequest.encounter mismatches, the dangling Immunization.encounter target) correctly stay GAP — the rule tolerates only same-CSN hits.",
        rejectsRegression:
          scope + " re-pointed to an Encounter with a different CSN, a wrong-system CSN, a non-Encounter, or a dangling ref -> GAP.",
      },
      hitCap: cap,
      verify: verifyEncounterRefByCsn,
    }),
  ),

  // ---- isomorphic-ref: Practitioner — Observation.performer + DocumentReference author/authenticator (by SER) ----
  // Reuse the strict-SER serKey() (system .99, /^\d{5,7}$/, exactly one) + name corroboration, identical
  // to iso-ref-encounter-participant-by-ser, so a same-SER twin or an EXTPROVID digit collision still GAPs.
  ...(["Observation.performer[].reference", "DocumentReference.author[].reference", "DocumentReference.authenticator.reference"] as const).map(
    (scope): MechanicalRule => ({
      id: "iso-ref-" + scope.replace(/\[\]/g, "").replace(/\./g, "-").replace(/-reference$/, "").toLowerCase() + "-by-ser",
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Resolve BOTH refs to a Practitioner. Extract SER STRICTLY by system (identifier.value @ " +
        OID_SER +
        ", trimmed, /^\\d{5,7}$/, exactly one per side — never a loose digit regex that also matches EXTPROVID .556 / INTERNAL .836982). Tolerate ONLY if (a) SERs equal AND (b) the two resolved Practitioners share a MULTI-CHARACTER (>=2 char) name token (family/given) — a shared single masked initial is NOT corroboration — so a coincidental SER/EXTPROVID collision to a different provider still GAPs. Missing/unequal/wrong-system SER, dangling ref, disjoint names, or only-an-initial-shared -> GAP.",
      rationale:
        "Practitioner SER (CCPROVID) is shared across both exports; only synthetic prac-<SER> vs opaque id differs. SER alone is non-injective (twins share a SER) so name corroboration is required — same machinery as iso-ref-encounter-participant-by-ser.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Strict .99-system SER selection + resolved-name corroboration (reused verbatim from the approved participant rule). Type-indexed to this exact element; a dangling our-side ref (e.g. an Observation.performer whose Practitioner is absent) correctly stays GAP.",
        rejectsRegression:
          "the performer/author/authenticator re-pointed to a same-SER twin with a different name, a loose-EXTPROVID match, a non-Practitioner, or a dangling ref -> GAP.",
      },
      // Observation cap raised 19->75: round-4 us-core category aligned more survey/social
      // Observations, surfacing their (verify-gated, same-SER + name) performer refs.
      hitCap: scope.startsWith("Observation") ? 75 : 28,
      verify: (ctx) => {
        const tres = resolveRef(ctx, ctx.targetVal, "tgt");
        const ores = resolveRef(ctx, ctx.ourVal, "our");
        const tk = serKey(tres), ok = serKey(ores);
        if (!tk || !ok || tk !== ok) return null;
        const tn = practitionerNameTokens(tres), on = practitionerNameTokens(ores);
        if (!tn.size || !on.size) return null;
        // shared token must be MULTI-CHARACTER: a single masked initial (Epic masks one name part to
        // an initial) is not corroboration and would let a same-SER different-family provider through.
        const shared = [...tn].some((t) => t.length >= 2 && on.has(t));
        return shared ? `same SER "${ok}" + corroborating multi-char name token` : null;
      },
    }),
  ),

  // ---- isomorphic-ref: Practitioner — extended SER family (requester/recorder/performer/etc.) ----
  // SAME strict-.99-SER + multi-char-name-corroboration machinery (shared verifyPractitionerRefBySer)
  // as iso-ref-encounter-participant-by-ser. Several of these scopes ALSO carry non-Practitioner refs
  // (e.g. DiagnosticReport.performer -> Organization, MedicationRequest.requester -> Organization);
  // those correctly resolve to null (no SER) and stay GAP — the rule tolerates ONLY the Practitioner
  // hits whose SER matches AND whose resolved names share a >=2-char token.
  ...(
    [
      ["iso-ref-medicationrequest-requester-by-ser", "MedicationRequest.requester.reference", 10],
      ["iso-ref-medicationrequest-recorder-by-ser", "MedicationRequest.recorder.reference", 10],
      ["iso-ref-diagnosticreport-performer-by-ser", "DiagnosticReport.performer[].reference", 9],
      ["iso-ref-goal-expressedby-by-ser", "Goal.expressedBy.reference", 1],
      ["iso-ref-patient-generalpractitioner-by-ser", "Patient.generalPractitioner[].reference", 1],
      ["iso-ref-immunization-performer-actor-by-ser", "Immunization.performer[].actor.reference", 2],
      ["iso-ref-documentreference-ext-valuereference-by-ser", "DocumentReference.extension[].extension[].valueReference.reference", 31],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Resolve BOTH refs to a Practitioner. Extract SER STRICTLY by system (identifier.value @ " +
        OID_SER +
        ", trimmed, /^\\d{5,7}$/, exactly one per side). Tolerate ONLY if (a) SERs equal AND (b) the two resolved Practitioners share a MULTI-CHARACTER (>=2 char) name token. A ref that resolves to a non-Practitioner (Organization/Device), a same-SER twin with a disjoint name, a loose-EXTPROVID match, or a dangling ref -> GAP.",
      rationale:
        "Practitioner SER (CCPROVID) is carried on both exports; only synthetic prac-<SER> vs opaque id differs. Reuses the approved encounter-participant SER machinery verbatim. Scopes that also carry Organization refs are handled by the fail-safe: a non-Practitioner has no SER -> null -> GAP.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Extends the approved SER family (verifyPractitionerRefBySer) to a same-shaped scope. Verified each tolerated hit is a same-SER Practitioner pair sharing a multi-char name token; the Organization/non-Practitioner refs on these same paths correctly stay GAP.",
        rejectsRegression:
          scope + " re-pointed to a same-SER twin with a different name, an Organization/non-Practitioner, a loose-EXTPROVID digit match, or a dangling ref -> GAP.",
      },
      hitCap: cap,
      verify: verifyPractitionerRefBySer,
    }),
  ),

  // ---- isomorphic-ref: Encounter by CSN — DocumentReference.context.encounter ----
  {
    id: "iso-ref-documentreference-context-encounter-by-csn",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "DocumentReference.context.encounter[].reference",
    predicate:
      "Resolve both refs to an Encounter and compare CSN identifier.value @ " +
      OID_CSN +
      " (require exactly one per side). Tolerate ONLY if byte-equal — same machinery as iso-ref-observation-encounter-by-csn. Re-point to an Encounter with a different CSN -> GAP.",
    rationale: "Same encounter; our enc-<CSN> id differs from the opaque id but the CSN identifier matches.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Byte-equal CSN compare bound to the resolved referent (reused from the approved Observation/Condition CSN rules). A different CSN stays GAP.",
      rejectsRegression: "context.encounter re-pointed to an Encounter with a different CSN, a wrong-system CSN, or a dangling ref -> GAP.",
    },
    // round-7: cap 28 -> 29. Same cause as iso-ref-documentreference-subject — the surfaced DocRefs each
    // carry a context.encounter that passes the byte-equal CSN verify (verify() returns null on any CSN
    // divergence). All 29 hits are verify-gated; bump tracks new real resources, not drift.
    hitCap: 29,
    verify: (ctx) => {
      const tk = csnKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = csnKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Encounter CSN "${ok}"` : null;
    },
  },

  // ---- isomorphic-ref: DiagnosticReport.result -> Observation (by Epic component code + effective) ----
  {
    id: "iso-ref-diagnosticreport-result-by-component",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "DiagnosticReport.result[].reference",
    predicate:
      "Resolve BOTH refs to an Observation. Build the natural key = the SINGLE Epic component code (code.coding.code @ " +
      OID_OBS_COMPONENT +
      ") + effective instant; require exactly one such code per side. Tolerate ONLY if the keys are byte-equal. Plain code.text/LOINC are NOT used (asymmetric across sides). A re-point to an Observation with a different component code/effective, a non-Observation, or a dangling ref -> GAP.",
    rationale:
      "Result Observations carry the Epic component code (.768282, e.g. 1557760 Cholesterol) byte-identically on both exports and it is unique per side; only the synthetic obs-<id> differs. This is the injective same-entity key the loose code.text/LOINC cannot provide.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Verified: all 46 result leaves carry a single .768282 component code present & byte-equal on both sides and UNIQUE per side (0 dup key groups), so the key is injective here; predicate re-derives it from data each run and GAPs any divergence.",
      rejectsRegression:
        "DiagnosticReport.result re-pointed to a different Observation (different component code or effective), a non-Observation, or a dangling ref -> GAP.",
    },
    hitCap: 46,
    verify: (ctx) => {
      const tk = obsComponentKey(resolveRef(ctx, ctx.targetVal, "tgt"));
      const ok = obsComponentKey(resolveRef(ctx, ctx.ourVal, "our"));
      return tk && ok && tk === ok ? `same Observation component-code key "${ok}"` : null;
    },
  },

  // ---- isomorphic-ref: Observation.specimen -> Specimen (by accession, FAIL-CLOSED on non-unique) ----
  {
    id: "iso-ref-observation-specimen-by-accession-unique",
    tier: "mechanical",
    kind: "isomorphic-ref",
    scope: "Observation.specimen.reference",
    predicate:
      "Resolve BOTH refs to a Specimen; read the SINGLE accession value (identifier.value @ " +
      OID_SPEC_ACC +
      "). Tolerate ONLY if ALL hold: (1) accessions equal; (2) FAIL-CLOSED: that accession resolves to EXACTLY ONE Specimen on EACH side (ctx.specimenAccessionUnique) — accession is non-injective (H613684 -> 3 byte-identical Serum specimens) so an ambiguous accession can NEVER justify the ref. Non-unique accession, unequal accession, non-Specimen, or dangling ref -> GAP.",
    rationale:
      "Where an accession is unambiguous (one Specimen per side) it is a true same-entity key; the synthetic spec-<id> differs but the resolved specimen is the same. The fail-closed uniqueness gate is exactly the guard the earlier accession rule lacked (see DROPPED iso-ref-observation-specimen-by-accession).",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED rescue of the DROPPED accession rule: only the unique-accession subset (12 of 40 leaves) is tolerated; the 28 leaves inside the H613684/H237948 collision groups stay GAP, so a re-point among same-accession specimens is never masked.",
      rejectsRegression:
        "Observation.specimen re-pointed to a DIFFERENT specimen that shares the accession (collision group), or to a different/absent accession -> GAP.",
    },
    hitCap: 12,
    verify: (ctx) => {
      const tres = resolveRef(ctx, ctx.targetVal, "tgt");
      const ores = resolveRef(ctx, ctx.ourVal, "our");
      const tk = specimenAccessionKey(tres), ok = specimenAccessionKey(ores);
      if (!tk || !ok || tk !== ok) return null;
      if (!ctx.specimenAccessionUnique("tgt", tk) || !ctx.specimenAccessionUnique("our", ok)) return null;
      return `same Specimen accession "${ok}" (unambiguous: one Specimen per side)`;
    },
  },

  // ---- structural-variant: DocumentReference content attachment Binary url (same note, our hash id vs Epic's opaque id) ----
  {
    id: "tolerate-documentreference-content-attachment-binary",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "DocumentReference.content[].attachment.url",
    predicate:
      "Tolerate the attachment.url ONLY when ALL hold: (1) BOTH sides are a 'Binary/...' reference; (2) our Binary/<id> RESOLVES to an actual Binary resource in our export (an unresolvable/dangling our ref -> GAP); (3) CONTENT IDENTITY: our url is 'Binary/bin-<sha1hex>' and that sha1hex equals hex(base64-decode(this content slot's sibling attachment.hash)) — i.e. the url points at the Binary holding EXACTLY the bytes this slot declares (a swap to a DIFFERENT note's Binary breaks this) ; (4) the OWNING DocumentReference shares the SAME note anchor on both sides — its DOCUMENT_ID (identifier.value @ " +
      OID_DOC_ID +
      ", exactly one per side) is byte-equal. The Binary ids themselves are NOT comparable (Epic mints an opaque server id; we mint a content-addressed Binary/bin-<sha1>), so the id is an unreproducible scheme difference for the SAME document. If our attachment.url points at a Binary whose embedded sha1 != the slot hash (a different payload), at a Binary under a DocumentReference with a DIFFERENT DOCUMENT_ID, at a non-Binary, or at a Binary absent from our export -> GAP.",
    rationale:
      "Round-2b mints Binary resources content-addressed by sha1 of the exact exported note bytes; the target points at Binary/<opaque-Epic-id>. Same note (same DOCUMENT_ID), same content slot, different (unreproducible) id scheme. The target Binary resource is itself absent from the target export, so the same-entity proof is the shared parent DOCUMENT_ID note anchor PLUS the content-identity check that our url's content-addressed sha1 equals the slot's own hash (so a same-DR swap to a different note's bytes still GAPs).",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Applied the pending rule once Binary emission landed. NARROWED beyond a blanket url ignore: both refs must be Binary/, our ref must RESOLVE, the url's content-addressed sha1 must equal this slot's attachment.hash (content identity), AND the parent DocumentReference DOCUMENT_ID (note anchor) must be byte-equal. Adversarially verified end-to-end: re-pointing our url at a DIFFERENT note's Binary GAPs (sha1 != slot hash); a different-DOCUMENT_ID parent GAPs; a non-Binary value GAPs; a dangling Binary ref GAPs.",
      rejectsRegression:
        "attachment.url re-pointed to a Binary holding different bytes (sha1 != slot hash), to a Binary under a DocumentReference with a different DOCUMENT_ID, to a non-Binary, or to a Binary absent from our export -> GAP.",
    },
    hitCap: 56,
    verify: (ctx) => {
      if (!isBinaryRef(ctx.targetVal) || !isBinaryRef(ctx.ourVal)) return null; // both must be Binary refs
      if (!resolveRef(ctx, ctx.ourVal, "our")) return null; // our Binary must actually exist (no dangling/wrong payload)
      // CONTENT IDENTITY: our content-addressed url sha1 must equal this slot's declared hash, so a swap
      // to a DIFFERENT note's Binary (different content) under the same DocumentReference still GAPs.
      if (!ourBinaryUrlMatchesSlotHash(ctx.ourVal, ctx.ourAt("hash"))) return null;
      const tk = docIdKey(ctx.targetRoot);
      const ok = docIdKey(ctx.ourRoot);
      if (!tk || !ok || tk !== ok) return null; // owning DocumentReference must be the SAME note (DOCUMENT_ID)
      return `same note DOCUMENT_ID "${ok}"; our url is content-addressed Binary (sha1==slot hash) vs Epic's opaque id`;
    },
  },

  // ---- structural-variant: DocumentReference content attachment contentType (Epic's rendering vs our classification) ----
  {
    id: "tolerate-documentreference-content-attachment-contenttype",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "DocumentReference.content[].attachment.contentType",
    predicate:
      "Tolerate the attachment.contentType ONLY when ALL hold: (1) the OWNING DocumentReference shares the SAME note anchor on both sides (DOCUMENT_ID @ " +
      OID_DOC_ID +
      ", byte-equal); (2) the sibling attachment.url is a 'Binary/...' reference on BOTH sides (so this is genuinely the rendered-note attachment slot, not some unrelated contentType); (3) BOTH contentType values are recognized text renderings of a clinical note from the SAME small allow-set {text/html, text/rtf, text/plain, text/xml}. Epic ships the note as text/html + text/rtf; we ship the source text/rtf + a derived text/plain — i.e. the SAME note content classified under different (but text-note) media types. A contentType that is NOT in the note-text allow-set (e.g. application/pdf, image/*), a missing Binary sibling, or a different DOCUMENT_ID -> GAP.",
    rationale:
      "Same note (DOCUMENT_ID), same content slot; Epic classifies its renderings as text/html / text/rtf while ours are text/rtf / text/plain. The divergence is the media-type classification of the same note, not a different document. Constrained to a text-note allow-set so a swap to a non-note media type still GAPs.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: not a blanket contentType ignore. Requires the same parent DOCUMENT_ID note anchor, a Binary url sibling on both sides, AND both values inside a small text-note media-type allow-set. Adversarially verified: a different-DOCUMENT_ID parent GAPs; a non-note contentType (application/pdf) GAPs.",
      rejectsRegression:
        "attachment.contentType set to a non-note media type (application/pdf, image/*, ...), or the owning DocumentReference re-anchored to a different DOCUMENT_ID, or the Binary url sibling absent -> GAP.",
    },
    hitCap: 28,
    verify: (ctx) => {
      const NOTE_TEXT = new Set(["text/html", "text/rtf", "text/plain", "text/xml"]);
      const tCt = norm(ctx.targetVal), oCt = norm(ctx.ourVal);
      if (!NOTE_TEXT.has(tCt) || !NOTE_TEXT.has(oCt)) return null; // both must be recognized note-text media types
      // the sibling attachment.url must be a Binary ref on BOTH sides (this is the note attachment slot)
      if (!isBinaryRef(ctx.targetAt("url")) || !isBinaryRef(ctx.ourAt("url"))) return null;
      const tk = docIdKey(ctx.targetRoot);
      const ok = docIdKey(ctx.ourRoot);
      if (!tk || !ok || tk !== ok) return null; // same note anchor
      return `same note DOCUMENT_ID "${ok}"; both contentType are note-text renderings (target "${ctx.targetVal}" vs our "${ctx.ourVal}")`;
    },
  },

  // ---- isomorphic-ref: Observation / DiagnosticReport basedOn -> ServiceRequest (same order, opaque vs sr-<ORDER_PROC_ID>) ----
  // The target ServiceRequest is opaque AND absent from the target export, and the order display is
  // NON-INJECTIVE (one panel ordered on two dates shares the display "BASIC METABOLIC PANEL"). So neither
  // resolution nor display can key the order. ctx.basedOnOrderMate provides the FAIL-CLOSED bijection:
  // the our-side ref a target ref maps to, kept ONLY where the (target<->our) basedOn pairing observed
  // across all aligned Observation/DiagnosticReport pairs is strictly 1:1. A re-point to a DIFFERENT order
  // makes the target ref co-occur with two our refs -> ambiguous -> the map drops it -> GAP.
  ...(
    [
      ["iso-ref-observation-basedon-by-order", "Observation.basedOn[].reference", 40],
      ["iso-ref-diagnosticreport-basedon-by-order", "DiagnosticReport.basedOn[].reference", 1],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Tolerate ONLY when BOTH sides are a 'ServiceRequest/...' reference AND ctx.basedOnOrderMate(targetRef) === ourRef, i.e. the target's opaque ServiceRequest ref maps — via the strict BIJECTION observed across all aligned Observation/DiagnosticReport.basedOn pairs — to exactly our ref (which is ServiceRequest/sr-<ORDER_PROC_ID>). The target ServiceRequest is opaque + absent from the target export and the order display is non-injective, so the bijective same-order map is the sole proof. A re-point to a DIFFERENT order makes the target ref ambiguous in the map (co-occurs with two our refs) -> null -> GAP.",
      rationale:
        "Both exports point basedOn at the SAME order; only synthetic sr-<ORDER_PROC_ID> vs the opaque target id differs. Display alone is non-injective (a panel ordered twice shares its name), so a fail-closed bijection — not the display — is what proves same-order.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Extends the iso-ref family with an order key. NARROWED past the non-injective display: keyed on the fail-closed (target<->our) basedOn bijection so that two same-named orders (two BASIC METABOLIC PANELs on different dates) are kept distinct. Adversarially verified: re-pointing one observation's basedOn from order A to order B makes A's target ref ambiguous -> the map drops it -> GAP; a non-ServiceRequest / display-only match is not tolerated.",
        rejectsRegression:
          scope + " re-pointed to a DIFFERENT order (different ORDER_PROC_ID) -> the bijection becomes ambiguous -> GAP; a non-ServiceRequest ref -> GAP.",
      },
      hitCap: cap,
      verify: (ctx) => {
        if (typeof ctx.targetVal !== "string" || typeof ctx.ourVal !== "string") return null;
        if (!ctx.targetVal.startsWith("ServiceRequest/") || !ctx.ourVal.startsWith("ServiceRequest/")) return null;
        const mate = ctx.basedOnOrderMate(ctx.targetVal);
        return mate && mate === ctx.ourVal ? `same order (bijective basedOn map: ${ctx.targetVal} <-> ${ctx.ourVal})` : null;
      },
    }),
  ),

  // ---- cosmetic-display: Patient subject display (Obs / Condition / Encounter / DocRef) ----
  {
    id: "cosmetic-observation-subject-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Observation.subject.display",
    predicate:
      "Tolerate ONLY when (1) sibling subject.reference resolves to the same Patient PAT_ID on both sides AND (2) BOTH the target display and our display are recorded name-forms of OUR Patient resource (every name[] entry as 'family, given...' plus name.text, normalized). Pins to the two-name-forms evidence, NOT the always-true singleton ref. A display drifted to a different person (Smith/Young/XXXXX/typo) matches no recorded form -> GAP.",
    rationale: "Same Patient; target nickname 'Mandel, Josh C' vs our fuller 'Mandel, Joshua C', both recorded name forms.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: the stated sibling-ref check is vacuous (one Patient => always same key), degenerating to a blanket field-ignore that tolerated wrong-person drift. Replaced with a name-form-of-our-Patient check that flags any non-recorded display as a GAP.",
      rejectsRegression:
        "subject.display drifted to a different person's name while the ref still resolves to the one Patient -> GAP.",
    },
    hitCap: 60,
    verify: (ctx) => patientSubjectDisplay(ctx, ctx.path),
  },
  {
    id: "cosmetic-condition-subject-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Condition.subject.display",
    predicate:
      "Same as cosmetic-observation-subject-display: tolerate only when sibling ref resolves to the same Patient PAT_ID AND both displays are recorded name-forms of our Patient. A wrong-person display (e.g. 'Mandel, Sara R') matches no recorded form -> GAP.",
    rationale: "Same Patient, nickname vs fuller name, both recorded name forms.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: constant 'patient' singleton key made the sibling check unable to distinguish Patients; pinned to recorded name-forms to restore the fail-safe (a household-linkage re-point to a second Patient would otherwise have been masked).",
      rejectsRegression: "Condition.subject.display set to a non-recorded name (different person) -> GAP.",
    },
    hitCap: 53,
    verify: (ctx) => patientSubjectDisplay(ctx, ctx.path),
  },
  {
    id: "cosmetic-encounter-subject-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Encounter.subject.display",
    predicate:
      "Tolerate only when sibling Encounter.subject.reference resolves to the same Patient PAT_ID AND both displays are recorded name-forms of our Patient. Otherwise -> GAP.",
    rationale: "Same Patient, nickname vs fuller name.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED for the same vacuous-singleton flaw; name-form check flags a display swapped to any other person even though the reference is unchanged.",
      rejectsRegression: "Encounter.subject.display = 'Smith, Robert A' / placeholder while ref unchanged -> GAP.",
    },
    hitCap: 32,
    verify: (ctx) => patientSubjectDisplay(ctx, ctx.path),
  },
  {
    id: "cosmetic-documentreference-subject-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "DocumentReference.subject.display",
    predicate:
      "Tolerate only when sibling DocumentReference.subject.reference resolves to the same Patient PAT_ID AND both displays are recorded name-forms of our Patient. A family-member's name filed in this chart matches no recorded form -> GAP.",
    rationale: "Same Patient, nickname vs fuller name.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED for the same vacuous-singleton flaw; EHI has other humans (DOC_LINKED_PATS, FAMILY_HX), so the name-form pin is what stops a mis-filed wrong-person label from being tolerated.",
      rejectsRegression: "DocumentReference.subject.display = a different person's name -> GAP.",
    },
    hitCap: 28,
    verify: (ctx) => patientSubjectDisplay(ctx, ctx.path),
  },

  // ---- cosmetic-display: Encounter participant display by SER-resolved Practitioner (narrowed) ----
  {
    id: "cosmetic-encounter-participant-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Encounter.participant[].individual.display",
    predicate:
      "Tolerate ONLY when (1) sibling .individual.reference resolves (per iso-ref-encounter-participant-by-ser) to a Practitioner with the SAME SER on both sides AND (2) the display is a name-form of THAT resolved Practitioner on EACH side independently (after normalize/tokenize, our display tokens subset/superset of our resolved Practitioner.name tokens; likewise target). Target 'Jess Y' (name family 'Y'/given 'Jess') vs our 'YOUNG, JESS' (family 'Young'/given 'Jess') both name-forms of SER 554385. A name swapped onto a correct ref (e.g. 'DHILLON, PUNEET S' on SER 554385) -> GAP.",
    rationale: "Same Practitioner (SER); privacy-mask vs full/cased name, each a name-form of the resolved provider.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: SER-only predicate validated the REFERENCE but not the DISPLAY; display and ref are independent code paths off PROV_ID, so a provName join bug could stamp the wrong clinician's name on a correct ref and be wrongly tolerated. Added per-side name-form check.",
      rejectsRegression:
        "correct SER ref but display = a different real clinician's name (wrong-name-on-correct-ref) -> GAP.",
    },
    // cap = verified true cluster size in the FULL compare (54); coversDeltas:32 was a stale
    // Observation-only survey estimate. All 54 hits verified privacy-mask vs full-name of the
    // SER-resolved Practitioner (0 different-person tolerations).
    hitCap: 54,
    verify: (ctx) => {
      const refPath = ctx.path.replace(/\.display$/, ".reference");
      const tres = resolveRef(ctx, ctx.targetAt(refPath), "tgt");
      const ores = resolveRef(ctx, ctx.ourAt(refPath), "our");
      const tk = serKey(tres), ok = serKey(ores);
      if (!tk || !ok || tk !== ok) return null;
      if (!displayMatchesPractitioner(ctx.targetVal, tres)) return null;
      if (!displayMatchesPractitioner(ctx.ourVal, ores)) return null;
      return `same SER "${ok}"; both displays are name-forms of the resolved Practitioner`;
    },
  },

  // ---- cosmetic-display: Encounter location display (narrowed: DEPARTMENT_NAME/EXTERNAL_NAME pin) ----
  {
    id: "cosmetic-encounter-location-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Encounter.location[].location.display",
    predicate:
      "Tolerate ONLY when ALL hold: (1) sibling .location.reference resolves on both sides (per iso-ref-encounter-location-by-name) to a Location whose normalized name is equal; (2) our display normalizes-equal to CLARITY_DEP.DEPARTMENT_NAME for the department whose id == our resolved Location id suffix (loc-<DEPARTMENT_ID>); (3) target display normalizes-equal to that SAME department row's EXTERNAL_NAME (== resolved Location.name on both sides). Pins the internal-label (DEPARTMENT_NAME) vs published-label (EXTERNAL_NAME) pair per department. Our display drifted to any other string (incl. another dept's label like 'MAC APL RADIOLOGY') -> GAP.",
    rationale:
      "Same Location (name key matches); our display is the dept INTERNAL DEPARTMENT_NAME, target is the published EXTERNAL_NAME — verified per department in CLARITY_DEP (e.g. dept 1700801002: 'MAC APL INTERNAL MEDICINE' / 'Assoc Physicians Internal Medicine').",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROWED: ref-name-only check was a blanket display ignore (would tolerate 'MAC APL RADIOLOGY' stamped on the Internal Medicine ref). Pinned both displays to the resolved department's DEPARTMENT_NAME / EXTERNAL_NAME rows. (Candidate-rule predicate text had the sides reversed; data is target=published, ours=internal — corrected here.)",
      rejectsRegression:
        "location.display changed to any string that is not this department's DEPARTMENT_NAME (incl. another dept's label) -> GAP.",
    },
    hitCap: 32,
    verify: (ctx) => {
      const refPath = ctx.path.replace(/\.display$/, ".reference");
      const tres = resolveRef(ctx, ctx.targetAt(refPath), "tgt");
      const ores = resolveRef(ctx, ctx.ourAt(refPath), "our");
      const tn = norm(tres?.name), on = norm(ores?.name);
      if (!tn || !on || tn !== on) return null; // (1) same resolved location name
      // department id from our resolved Location id suffix loc-<DEPARTMENT_ID>
      const m = /^loc-(\d+)$/.exec(String(ores?.id || ""));
      if (!m) return null;
      const dep = ctx.department(m[1]);
      if (!dep) return null;
      const internal = norm(dep.DEPARTMENT_NAME);
      const external = norm(dep.EXTERNAL_NAME);
      if (!internal || !external) return null;
      if (norm(ctx.ourVal) !== internal) return null; // (2) our display == DEPARTMENT_NAME
      if (norm(ctx.targetVal) !== external) return null; // (3) target display == EXTERNAL_NAME
      if (external !== on) return null; // EXTERNAL_NAME is also the resolved Location.name
      return `dept ${m[1]}: our display==DEPARTMENT_NAME "${dep.DEPARTMENT_NAME}", target display==EXTERNAL_NAME "${dep.EXTERNAL_NAME}"`;
    },
  },

  // ===========================================================================
  // Family A — COSMETIC-DISPLAY for masked names (sibling ref already iso-tolerated to SAME entity)
  // ===========================================================================
  // (A.1) Practitioner displays whose sibling .reference is SER-iso-tolerated. Target is Epic's
  // privacy-masked name ("Mary S"); ours is the fuller EHI name ("SMITH, MARY B"). Same machinery as
  // cosmetic-encounter-participant-display, applied to every parallel performer/author/authenticator/
  // requester/recorder/valueReference/actor/expressedBy/generalPractitioner display whose ref the
  // iso-ref-*-by-ser family already tolerates. Scopes that ALSO carry Organization / medication refs
  // (DiagnosticReport.performer "UPH MADISON SUNQUEST LAB", MedicationRequest.medicationReference) are
  // handled by the fail-safe: a non-Practitioner ref has no SER -> verify returns null -> GAP.
  ...(
    [
      // cap raised 19->72: round-4's us-core category work made more survey/social Observations
      // ALIGN, surfacing their (already verify-gated, same-SER + multi-char-name) performer displays.
      // Every hit still re-derives same-SER + name corroboration; the cluster grew, the rule did not loosen.
      ["cosmetic-observation-performer-display", "Observation.performer[].display", 72],
      ["cosmetic-documentreference-author-display", "DocumentReference.author[].display", 28],
      ["cosmetic-documentreference-authenticator-display", "DocumentReference.authenticator.display", 28],
      ["cosmetic-documentreference-ext-valuereference-display", "DocumentReference.extension[].extension[].valueReference.display", 31],
      ["cosmetic-diagnosticreport-performer-display", "DiagnosticReport.performer[].display", 9],
      ["cosmetic-medicationrequest-requester-display", "MedicationRequest.requester.display", 10],
      ["cosmetic-medicationrequest-recorder-display", "MedicationRequest.recorder.display", 10],
      ["cosmetic-immunization-performer-actor-display", "Immunization.performer[].actor.display", 2],
      ["cosmetic-goal-expressedby-display", "Goal.expressedBy.display", 1],
      ["cosmetic-patient-generalpractitioner-display", "Patient.generalPractitioner[].display", 1],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "cosmetic-display",
      scope,
      predicate:
        "Tolerate ONLY when ALL hold: (1) the sibling ." +
        scope.replace(/\.display$/, ".reference").replace(/^.*\./, "") +
        " on the SAME owner resolves on BOTH sides (per iso-ref-*-by-ser) to a Practitioner carrying the SAME strict SER (identifier.value @ " +
        OID_SER +
        ", /^\\d{5,7}$/, exactly one per side) — i.e. the SAME entity that family already iso-tolerates; (2) those Practitioners share a MULTI-CHARACTER (>=2 char) name token (defeats a same-SER twin / EXTPROVID collision); (3) BOTH displays are recorded name-forms of THEIR OWN resolved Practitioner (target privacy-masked 'Mary S' is a name-form of the masked Practitioner; our 'SMITH, MARY B' is a name-form of our fuller name). A sibling ref to a DIFFERENT entity (different/absent SER, an Organization, a dangling ref), or a display swapped to a DIFFERENT real clinician's name on a correct ref, -> GAP.",
      rationale:
        "Epic privacy-masks the display to title + first-initial + last-initial-or-family ('Mary S'); our EHI export carries the fuller name ('SMITH, MARY B'). The SIBLING reference is already iso-tolerated (same SER) so this is the same provider; only the display string's masking differs. Same per-side name-form pin as cosmetic-encounter-participant-display so a wrong-name-on-correct-ref still GAPs.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Extends the approved cosmetic-encounter-participant-display machinery (SER-resolved sibling ref + per-side name-form pin) to the parallel display of every iso-ref-*-by-ser scope. Injection-self-checked: importing the real verify, an injected wrong-clinician display on a correct SER ref GAPs; the Organization/medication refs on these same paths (no SER) correctly stay GAP.",
        rejectsRegression:
          scope + " display set to a DIFFERENT real clinician's name on a correct SER ref, or the sibling ref re-pointed to a different/absent SER, an Organization, or a dangling ref -> GAP.",
      },
      hitCap: cap,
      verify: verifyMaskedNameDisplayBySer,
    }),
  ),

  // (A.2) Encounter enc-type-label displays whose sibling .encounter.reference is CSN-iso-tolerated.
  // Target ships Epic's GENERIC enc-type master label ("Office Visit"); we ship the specific visit/
  // procedure label ("PR PREVENTIVE VISIT,EST,18-39") for the SAME contact. The same-CSN sibling-ref
  // check IS the anti-regression guard: a display on a DIFFERENT encounter needs a re-pointed reference
  // (different CSN) -> GAP. (DiagnosticReport.encounter.display included; it is the same CSN family.)
  ...(
    [
      ["cosmetic-observation-encounter-display", "Observation.encounter.display", 20],
      ["cosmetic-diagnosticreport-encounter-display", "DiagnosticReport.encounter.display", 1],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "cosmetic-display",
      scope,
      predicate:
        "Tolerate ONLY when the sibling .encounter.reference resolves on BOTH sides (per iso-ref-*-encounter-by-csn) to an Encounter carrying the SAME single CSN (identifier.value @ " +
        OID_CSN +
        ", exactly one per side) AND both displays are non-empty labels. The display differs only because Epic ships the GENERIC enc-type master label ('Office Visit') while we ship the specific visit/procedure label for the SAME contact. The same-CSN sibling-ref check is the anti-regression guard: a display on a DIFFERENT encounter requires a re-pointed reference (a different CSN) -> GAP. A dangling/non-Encounter ref or an empty display -> GAP.",
      rationale:
        "The sibling .encounter.reference is already CSN-iso-tolerated (same Encounter); only the enc-type display label differs (Epic's master enc-type label vs our specific visit label). Per the task family this is tolerated where the reference resolves to the SAME natural-key entity; a display on a different entity GAPs because its ref would carry a different CSN.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "Same-CSN sibling-ref guard (reused csnKey from the approved iso-ref CSN family). Injection-self-checked: an injected re-point of the sibling .encounter.reference to a different-CSN Encounter GAPs; the genuine 'Office Visit' vs our visit-label pairs on the SAME CSN tolerate.",
        rejectsRegression:
          scope + " sibling .encounter.reference re-pointed to an Encounter with a different CSN (a display on a different entity), or a dangling/non-Encounter ref, or an empty display -> GAP.",
      },
      hitCap: cap,
      verify: verifyEncounterTypeLabelDisplay,
    }),
  ),

  // ===========================================================================
  // NEW Family — COSMETIC-CASE for coding.display / CodeableConcept.text (task A).
  // Epic title-cases the master reason label ("Annual Exam") while our EHI source ships it upper-case
  // ("ANNUAL EXAM"); the {system,code} concept (Epic reason OID .728286) is byte-equal on both sides,
  // so the ONLY divergence is letter casing of the SAME coded concept. Tolerate ONLY when the displays
  // are EQUAL after case-fold (a real-letter difference -> GAP) AND the sibling concept matches:
  //   - coding[].display: the SAME coding object's {system,code} are byte-equal across sides;
  //   - reasonCode[].text: the CodeableConcept's coding concept SET is byte-equal across sides.
  // A display/text on a DIFFERENT concept (different/absent code, or a different coding set) is left a
  // GAP even if the words happen to match.
  // ===========================================================================
  {
    id: "cosmetic-case-encounter-reasoncode-coding-display",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Encounter.reasonCode[].coding[].display",
    predicate:
      "Tolerate ONLY when (1) target and our coding.display are EQUAL after case-fold/whitespace-normalize (norm) — a display differing by ACTUAL LETTERS, not just case, -> GAP; (2) the sibling {system,code} on the SAME coding object are byte-equal (norm) across sides AND a code is present — i.e. the SAME coded concept (Epic reason OID " +
      "1.2.840.114350.1.13.283.2.7.2.728286). A display on a DIFFERENT concept (different/absent code, different system) -> GAP even if the words match.",
    rationale:
      "Epic title-cases the reason master display ('Annual Exam'); our EHI source ships it upper-case ('ANNUAL EXAM'). Same {system,code} concept, presentation-only casing difference.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROW cosmetic-CASE: pinned to (a) case-fold display equality AND (b) byte-equal sibling {system,code} on the same coding object, so only a same-concept re-casing is tolerated. Injection-self-checked: a display changed to different LETTERS GAPs; a same-word display under a DIFFERENT code GAPs; the genuine 'Annual Exam'/'ANNUAL EXAM' same-code pairs tolerate.",
      rejectsRegression:
        "Encounter.reasonCode[].coding[].display changed to genuinely different letters (not just case), or the same words placed on a different/absent coding code -> GAP.",
    },
    hitCap: 30,
    verify: verifyCosmeticCaseCodingDisplay,
  },
  {
    id: "cosmetic-case-encounter-reasoncode-text",
    tier: "mechanical",
    kind: "cosmetic-display",
    scope: "Encounter.reasonCode[].text",
    predicate:
      "Tolerate ONLY when (1) target and our reasonCode.text are EQUAL after case-fold/whitespace-normalize (norm) — different actual letters -> GAP; (2) the CodeableConcept's coding[] concept SET ({system,code} pairs, sorted) is byte-equal across sides AND non-empty — i.e. this reasonCode names the SAME coded concept(s), so its .text is that concept's label re-cased. A text on a DIFFERENT concept set, or with no coded concept to anchor it, -> GAP.",
    rationale:
      "The reasonCode.text mirrors the coding display: Epic title-case vs our upper-case for the SAME concept set. Anchored to the byte-equal coding concept set so a different reason still GAPs.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROW cosmetic-CASE for the CodeableConcept .text leaf: case-fold text equality AND byte-equal coding concept SET. Injection-self-checked: a text changed to different letters GAPs; a same-word text whose coding concept set differs GAPs; the genuine same-set re-casing tolerates.",
      rejectsRegression:
        "Encounter.reasonCode[].text changed to genuinely different letters, or the same words on a CodeableConcept whose coding concept set differs -> GAP.",
    },
    hitCap: 30,
    verify: verifyCosmeticCaseCodeableText,
  },

  // ===========================================================================
  // Family A2 — COSMETIC-DISPLAY (code-gated, any wording) for coding[].display
  // ===========================================================================
  ...(
    [
      ["cosmetic-display-condition-code-coding-display", "Condition.code.coding[].display", 30],
      ["cosmetic-display-observation-code-coding-display", "Observation.code.coding[].display", 30],
      ["cosmetic-display-observation-value-coding-display", "Observation.valueCodeableConcept.coding[].display", 25],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "cosmetic-display",
      scope,
      predicate:
        "Tolerate a coding.display difference of ANY wording ONLY when the SAME coding object's sibling {system,code} are byte-equal (norm) across sides AND a code is present — coding.display is a NON-NORMATIVE label for the authoritative {system,code}, so a same-{system,code} display variant (SNOMED FSN vs short label; Epic master 'Blood Pressure' vs our flowsheet 'BP' on the SAME OID+FLO_MEAS_ID) is presentation-only. A display on a DIFFERENT or absent code, or a different system, -> GAP even if related.",
      rationale:
        "FHIR coding.display is the human label for the code; the code carries the meaning. classify.ts pairs the display to its own {system,code} owner, so this only ever tolerates a wording variant of the IDENTICAL coded concept.",
      approval: {
        status: "approved",
        reviewer: "agent:coordinator",
        note: "User-approved code-gated display tolerance (broadens cosmetic-CASE to any wording). Injection-self-checked: a display moved onto a DIFFERENT code GAPs; an absent sibling code GAPs; a different system GAPs; the genuine same-{system,code} wording variants tolerate.",
        rejectsRegression:
          scope + " display placed on a different/absent coding code, or a different code system -> GAP.",
      },
      hitCap: cap,
      verify: verifyCosmeticDisplayByCode,
    }),
  ),

  // ===========================================================================
  // Family A3 — ISO-REF by fail-closed BIJECTION for opaque-target references
  // (user-approved extension of the attachment opaque-id ruling). The target ref is an opaque
  // Epic server id absent from the target export, so it cannot be resolved/keyed; ctx.refBijectionMate
  // returns our ref ONLY when the (target<->our) pairing is a strict bijection across all aligned
  // pairs at the scope (a re-point to a different entity makes it ambiguous -> null -> GAP).
  // ===========================================================================
  ...(
    [
      ["iso-ref-medicationrequest-medication-bijection", "MedicationRequest.medicationReference.reference", "Medication/", 30],
      ["iso-ref-observation-specimen-bijection", "Observation.specimen.reference", "Specimen/", 40],
      ["iso-ref-diagnosticreport-specimen-bijection", "DiagnosticReport.specimen[].reference", "Specimen/", 20],
      ["iso-ref-condition-evidence-detail-bijection", "Condition.evidence[].detail[].reference", "Condition/", 30],
      ["iso-ref-observation-derivedfrom-bijection", "Observation.derivedFrom[].reference", "Observation/", 20],
      ["iso-ref-medicationrequest-priorprescription-bijection", "MedicationRequest.priorPrescription.reference", "MedicationRequest/", 20],
      ["iso-ref-medicationrequest-encounter-bijection", "MedicationRequest.encounter.reference", "Encounter/", 20],
      ["iso-ref-immunization-encounter-bijection", "Immunization.encounter.reference", "Encounter/", 20],
      ["iso-ref-condition-encounter-bijection", "Condition.encounter.reference", "Encounter/", 10],
      ["iso-ref-careplan-addresses-bijection", "CarePlan.addresses[].reference", "Condition/", 10],
      ["iso-ref-careplan-goal-bijection", "CarePlan.goal[].reference", "Goal/", 10],
      ["iso-ref-coverage-payor-bijection", "Coverage.payor[].reference", "Organization/", 10],
      ["iso-ref-patient-managingorganization-bijection", "Patient.managingOrganization.reference", "Organization/", 10],
    ] as const
  ).map(
    ([id, scope, prefix, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "isomorphic-ref",
      scope,
      predicate:
        "Tolerate ONLY when BOTH sides are a '" + prefix + "...' reference AND ctx.refBijectionMate(\"" + scope +
        "\", targetVal) === ourVal — the opaque target id maps, via the strict (target<->our) BIJECTION observed across ALL aligned pairs at this scope, to exactly our ref. The target id is opaque + absent from the target export, so the fail-closed bijection is the sole proof of same-entity. A re-point to a DIFFERENT entity makes the target ref co-occur with two our refs -> dropped from the map -> null -> GAP; a non-'" + prefix + "' ref -> GAP.",
      rationale:
        "Same machinery + honesty basis as the user-approved attachment opaque-id tolerance and the basedOn order bijection: only synthetic-vs-opaque id scheme differs for the SAME referenced entity. medicationReference is structurally 1:1 (one Medication per ORDER_MED); specimen/evidence are bound by the fail-closed bijection.",
      approval: {
        status: "approved",
        reviewer: "agent:coordinator",
        note: "User-approved (extend opaque-id iso-ref to med + specimen/evidence). NARROW: keyed on the strict bijection (not display, which is non-injective), so two same-named entities stay distinct. Self-checked: re-pointing one leaf to a different entity makes its target ref ambiguous -> the map drops it -> GAP; a non-matching-prefix ref -> GAP.",
        rejectsRegression:
          scope + " re-pointed to a different entity (bijection becomes ambiguous) or a non-'" + prefix + "' ref -> GAP.",
      },
      hitCap: cap,
      verify: (ctx) => {
        const t = ctx.targetVal, o = ctx.ourVal;
        if (typeof t !== "string" || typeof o !== "string") return null;
        if (!t.startsWith(prefix) || !o.startsWith(prefix)) return null;
        const mate = ctx.refBijectionMate(scope, t);
        return mate && mate === o ? `same entity via fail-closed bijection (${o})` : null;
      },
    }),
  ),

  // ===========================================================================
  // Family B — MINUTE-PRECISION for instants (export rounds *_DTTM to the minute -> our :00 seconds)
  // ===========================================================================
  ...(
    [
      ["minute-rounded-observation-issued", "Observation.issued", 75],
      ["minute-rounded-diagnosticreport-issued", "DiagnosticReport.issued", 7],
      ["minute-rounded-documentreference-date", "DocumentReference.date", 28],
      ["minute-rounded-allergyintolerance-recordeddate", "AllergyIntolerance.recordedDate", 4],
      ["minute-rounded-encounter-period-start", "Encounter.period.start", 2],
      ["minute-rounded-encounter-period-end", "Encounter.period.end", 2],
      ["minute-rounded-documentreference-context-period-start", "DocumentReference.context.period.start", 5],
      ["minute-rounded-documentreference-context-period-end", "DocumentReference.context.period.end", 5],
      ["minute-rounded-documentreference-ext-valuedatetime", "DocumentReference.extension[].extension[].valueDateTime", 31],
      ["minute-rounded-documentreference-authenticator-ext-valuedatetime", "DocumentReference.authenticator.extension[].valueDateTime", 28],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "structural-variant",
      scope,
      predicate:
        "Tolerate ONLY when BOTH values are well-formed second-precision ISO instants that are byte-equal after TRUNCATING to the minute (same YYYY-MM-DDThh:mm AND same timezone suffix) AND OUR value's seconds component is exactly '00' — i.e. ours is the minute-ROUNDED form the EHI export emits for *_DTTM columns while the target keeps real seconds. A different minute/hour/day, a different timezone, OUR value carrying non-zero seconds (a real second-level divergence that merely lands in the same minute), or a malformed instant -> GAP.",
      rationale:
        "The EHI export rounds *_DTTM source columns to the minute, so our instant is 'YYYY-MM-DDThh:mm:00Z' while the target carries the true seconds 'YYYY-MM-DDThh:mm:ssZ'. Same instant to the minute; the seconds are the export's rounding, not a real difference. Requiring our seconds == '00' keeps a genuine same-minute-but-different-seconds pair (e.g. some DiagnosticReport.issued rows where BOTH sides have non-zero seconds) as a GAP.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "NARROWED past a blanket truncate-to-minute compare: also requires OUR seconds == '00' so only the actual export-rounding artifact is tolerated, not any coincidental same-minute pair. Injection-self-checked: an injected target shifted to a different minute GAPs; a same-minute pair where ours has non-zero seconds GAPs; the genuine ':00'-rounded pairs tolerate.",
        rejectsRegression:
          scope + " target/ours differing in the minute/hour/day or timezone, OR ours carrying non-zero seconds (a real second-level change) -> GAP.",
      },
      hitCap: cap,
      verify: verifyMinuteRoundedInstant,
    }),
  ),

  // ===========================================================================
  // Family C — ENCOUNTER.CLASS structural-variant (standard v3-ActCode vs Epic-local class)
  // ===========================================================================
  ...(["Encounter.class.system", "Encounter.class.code", "Encounter.class.display"] as const).map(
    (scope): MechanicalRule => ({
      id: "encounter-class-standard-vs-epiclocal-" + scope.replace(/^Encounter\.class\./, ""),
      tier: "mechanical",
      kind: "structural-variant",
      scope,
      predicate:
        "Tolerate this Encounter.class field ONLY when ALL hold: (1) the TARGET class.system is Epic's PROPRIETARY class OID (" +
        SYS_EPIC_ENC_CLASS +
        ") and OUR class.system is the standard v3-ActCode (" +
        SYS_V3_ACTCODE +
        ") — exactly the standard-vs-Epic-local axis; (2) the owning Encounter carries the SAME single CSN on both sides; (3) ctx.encounterStdClass(CSN) — the standard v3-ActCode our buildClass DERIVES from THIS encounter's ADT_PAT_CLASS_C_NAME via the documented enum map — equals OUR emitted class triple (system+code+display), so our class is the VERIFIED-correct standard mapping of the encounter's ADT class; (4) the TARGET class.code is a known Epic-local OUTPATIENT class code {13,5,4}. A wrong derived class (ours != the ADT-derived standard mapping), a non-Epic-local target system, a non-v3-ActCode our system, an unknown/INPATIENT Epic-local code, or a CSN mismatch -> GAP.",
      rationale:
        "FHIR R4 REQUIRES Encounter.class to be a v3-ActCode Coding (a standard value set); Epic's proprietary class (system .13260, '13'/'5'/'4') is NOT in that value set and is absent from the rest of the export. We DERIVE the standard code from the encounter's ADT patient class (ADT_PAT_CLASS_C_NAME -> v3-ActCode). The divergence is the SAME class concept expressed in the required standard vocabulary vs Epic's local one. Verified per encounter: ours must equal the ADT-class-derived standard mapping, so a wrong class still GAPs.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "NARROWED to a per-encounter standard-mapping equality (not a blanket 'tolerate any class diff'): re-derives the expected v3-ActCode from THIS encounter's ADT class via ctx.encounterStdClass and tolerates ONLY if ours matches. Injection-self-checked: an injected wrong our-side class (e.g. IMP where the ADT class derives AMB) GAPs; a future Epic-local inpatient code GAPs; the genuine AMB-vs-Epic-outpatient triples tolerate.",
        rejectsRegression:
          scope + " where our class is NOT the correct ADT-class-derived standard mapping (e.g. ours mislabeled IMP/EMER while the encounter's ADT class derives AMB), the target system is not the Epic-local class OID, or the target Epic-local code is an inpatient concept -> GAP.",
      },
      hitCap: 32,
      verify: verifyEncounterClassVariant,
    }),
  ),

  // ---- structural-variant: meta.versionId (server-minted unversioned stamp) ----
  // versionId is stamped by the FHIR server on read; there is no faithful EHI source for it. Tolerate
  // ONLY the literal first-write stamp "1": a target versionId of "1" against any our value is a
  // server-only artifact. A REAL edit-history versionId ("2","3",...) is NOT this artifact -> GAP, so
  // a genuine version divergence is never masked. (Zero-hit on the current dataset: neither side emits
  // meta. Pre-registered so a future server-minted meta is reviewed, not blind-ignored.)
  {
    id: "server-artifact-meta-versionid",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "meta.versionId",
    predicate:
      'Tolerate ONLY when the TARGET meta.versionId is exactly the literal "1" (the server\'s unversioned first-write stamp). Any other target versionId (a real edit-history "2"/"3"/...) -> GAP. Server-minted; no faithful EHI source per the deep-dive.',
    rationale:
      'meta.versionId is server-minted on read, not authored from EHI. "1" is the inert first-write stamp; a higher version reflects real server-side edits we do not (and should not silently) reproduce.',
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: 'Narrowed to the literal "1" so only the inert first-write stamp is server-tolerated; any real version (>1) stays a GAP. Verified against an injected versionId "2" which correctly GAPped. Zero-hit today (no meta emitted on either side).',
      rejectsRegression: 'a target meta.versionId other than "1" (e.g. "2", a real edit history) -> GAP.',
    },
    hitCap: 0,
    verify: (ctx) => (String(ctx.targetVal) === "1" ? `server-minted versionId "1" (no faithful EHI source)` : null),
  },

  // ---- structural-variant: meta.lastUpdated (server load timestamp) ----
  // lastUpdated is the server's load/refresh instant; no faithful EHI column authors it. Tolerate ONLY
  // when the target value parses as a valid ISO instant (a plausible server timestamp). A garbage /
  // non-instant value -> GAP. The instant is NOT pinned (it legitimately varies per export run), but the
  // shape is verified so a corrupted value is not blind-ignored. (Zero-hit today: no meta emitted.)
  {
    id: "server-artifact-meta-lastupdated",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "meta.lastUpdated",
    predicate:
      "Tolerate ONLY when the TARGET meta.lastUpdated parses as a valid ISO-8601 instant (YYYY-MM-DDThh:mm:ss[.sss](Z|+hh:mm)). A non-instant / malformed value -> GAP. Server-minted load timestamp; varies per run, so the instant itself is not pinned, only its well-formedness is verified.",
    rationale:
      "meta.lastUpdated is the server's resource-load instant, not an EHI field. It is intrinsically run-variable, so it can only be tolerated as a server artifact; verifying it is a well-formed instant keeps a corrupted value as a GAP.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "Tolerates a well-formed server instant only; a malformed/non-instant lastUpdated stays a GAP. Verified against an injected value 'not-a-date' which correctly GAPped. Zero-hit today (no meta emitted on either side).",
      rejectsRegression: "a target meta.lastUpdated that is not a well-formed ISO instant -> GAP.",
    },
    hitCap: 0,
    verify: (ctx) =>
      typeof ctx.targetVal === "string" && ISO_INSTANT.test(ctx.targetVal) && !isNaN(Date.parse(ctx.targetVal))
        ? `server-minted lastUpdated instant (no faithful EHI source; instant is run-variable so not pinned)`
        : null,
  },

  // ===========================================================================
  // NEW Family (task A) — COSMETIC-CASE for free-text NAME / ADDRESS values (no code anchor).
  // Tolerate ONLY a norm-equal (lower+trim+collapse) re-casing of the SAME element; a real-letter
  // difference (truncation, abbreviation, masked initial, [REDACTED-*] PHI) stays a GAP. Each scope
  // is compared against the SAME element on the aligned resource (never paired across entities).
  // ===========================================================================
  ...(
    [
      ["cosmetic-case-patient-name-family", "Patient.name[].family", 2],
      ["cosmetic-case-patient-name-given", "Patient.name[].given[]", 2],
      ["cosmetic-case-organization-name", "Organization.name", 3],
      ["cosmetic-case-organization-address-line", "Organization.address[].line[]", 1],
      ["cosmetic-case-organization-address-text", "Organization.address[].text", 1],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "cosmetic-case",
      scope,
      predicate:
        "Tolerate ONLY when target and our value at this SAME element are EQUAL after norm() (lowercase + trim + collapse internal whitespace) AND both are non-empty strings — i.e. the ONLY divergence is letter-CASE of the SAME free-text value (Epic title-cases the master string while our faithful EHI source ships it upper-case). This leaf has NO {system,code} anchor, so norm-equality of the SAME element is the sole admissible proof; the consumer never pairs it across entities. A value differing by ACTUAL LETTERS (truncation, abbreviation 'St' vs 'Street', a different word, a masked initial 'Mary S', a [REDACTED-*] PHI placeholder) is NOT norm-equal -> GAP. A present-vs-absent value -> GAP.",
      rationale:
        "Name/address free-text values diverge between the exports only by letter-case (e.g. 'MANDEL'/'Mandel', 'MAC ASSOCIATED PHYSICIANS LLP'/'Mac Associated Physicians LLP', '4410 REGENT ST'/'4410 Regent St'). Same characters, different casing only.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "NARROW cosmetic-CASE gated STRICTLY on norm-equality of the SAME element (no cross-entity pairing, no code anchor needed). Injection-self-checked: a real-letter difference ('36 S Brooks Street' vs 'St', a masked-initial name, a [REDACTED-*] placeholder) is NOT norm-equal -> GAP; only same-characters/different-case pairs tolerate.",
        rejectsRegression:
          scope + " differing by actual letters (truncation, abbreviation, a different word, a masked initial, or a [REDACTED-*] PHI placeholder), or a present-vs-absent value -> GAP.",
      },
      hitCap: cap,
      verify: verifyCosmeticCaseValue,
    }),
  ),

  // ===========================================================================
  // NEW Family (task B) — USPS STATE name <-> 2-letter abbreviation for address[].state.
  // Tolerate ONLY when both sides name the SAME state via the fixed USPS table (either direction);
  // a DIFFERENT state, or a value not in the table, -> GAP. (Patient.address[].state pre-registered;
  // zero-hit today because both sides already ship "WI" byte-equal.)
  // ===========================================================================
  ...(
    [
      ["state-name-expansion-organization-address", "Organization.address[].state", 2],
      ["state-name-expansion-patient-address", "Patient.address[].state", 0],
    ] as const
  ).map(
    ([id, scope, cap]): MechanicalRule => ({
      id,
      tier: "mechanical",
      kind: "structural-variant",
      scope,
      predicate:
        "Tolerate the address[].state divergence ONLY when both sides name the SAME state via a FIXED USPS 2-letter<->name table: normalize each side, map it to its canonical 2-letter code (a value may be a code 'WI' OR a full name 'Wisconsin'), and tolerate ONLY when the two canonical codes are EQUAL. A value naming a DIFFERENT state ('WI' vs 'Minnesota', 'WI' vs 'IL'), or a value not present in the fixed table (garbage/unknown), -> GAP.",
      rationale:
        "Epic ships the state as a 2-letter USPS code on one side and the spelled-out name on the other (Organization.address[].state 'WI' vs 'Wisconsin'). Same state, abbreviation-vs-name only; verified against a fixed USPS table so a different state still GAPs.",
      approval: {
        status: "approved",
        reviewer: "agent:reviewer",
        note: "NARROW state-name expansion gated on a fixed USPS 2-letter<->name table (both directions). Injection-self-checked: 'WI' vs 'Minnesota' and 'WI' vs 'IL' GAP (different canonical code); an unknown value GAPs; only same-state code/name pairs tolerate.",
        rejectsRegression:
          scope + " naming a DIFFERENT state (different USPS canonical code) or a value not in the fixed USPS table -> GAP.",
      },
      hitCap: cap,
      verify: verifyStateNameExpansion,
    }),
  ),

  // ===========================================================================
  // NEW Family (task C) — AllergyIntolerance clinicalStatus/verificationStatus coding .version "4.0.0".
  // OUR-SIDE-ABSENT structural variant: the target stamps the status coding with the server-applied
  // ValueSet version "4.0.0" while our faithful EHI export omits .version. Tolerated ONLY for these two
  // status scopes, ONLY when our side carries the SAME status code under the SAME system (so the version
  // is the only divergence). appliesWhenOurAbsent => also consulted in the consumer's missing branch.
  // ===========================================================================
  {
    id: "allergy-clinicalstatus-version-server-stamp",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "AllergyIntolerance.clinicalStatus.coding[].version",
    appliesWhenOurAbsent: true,
    predicate:
      "Tolerate the our-side-ABSENT clinicalStatus coding .version ONLY when ALL hold: (1) OUR side omits the version (ctx.ourVal is null — this is a structural our-absent rule); (2) the TARGET .version is exactly the literal '4.0.0' (the server-applied FHIR R4 ValueSet version); (3) the OWNING target coding's sibling {system,code} name a real status concept under " +
      SYS_ALLERGY_CLINICAL +
      "; (4) OUR AllergyIntolerance.clinicalStatus carries a coding with that SAME code under that SAME system (so the ValueSet version is the ONLY divergence on a status we DO emit). Any non-'4.0.0' version, a .version on a different/wrong-system coding, or our side missing that status code -> GAP.",
    rationale:
      "The status coding's .version is the ValueSet/CodeSystem version the FHIR server applies when expanding the required allergy clinical-status value set; there is no faithful EHI column that authors a ValueSet version, so our export omits it. Same status concept, server-stamped version only.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROW our-side-absent server-stamp tolerance scoped to clinicalStatus only and pinned to the literal '4.0.0' on a real status concept our side also emits. Injection-self-checked: a target .version other than '4.0.0' GAPs; a .version whose sibling code our side does not emit GAPs; the genuine '4.0.0'-vs-absent pairs tolerate.",
      rejectsRegression:
        "AllergyIntolerance.clinicalStatus coding .version other than '4.0.0', a version on a non-status/wrong-system coding, or a status code our side does not emit -> GAP.",
    },
    hitCap: 4,
    verify: makeVerifyAllergyStatusVersion("clinicalStatus", SYS_ALLERGY_CLINICAL),
  },
  {
    id: "allergy-verificationstatus-version-server-stamp",
    tier: "mechanical",
    kind: "structural-variant",
    scope: "AllergyIntolerance.verificationStatus.coding[].version",
    appliesWhenOurAbsent: true,
    predicate:
      "Tolerate the our-side-ABSENT verificationStatus coding .version ONLY when ALL hold: (1) OUR side omits the version (ctx.ourVal is null); (2) the TARGET .version is exactly '4.0.0'; (3) the OWNING target coding's sibling {system,code} name a real status concept under " +
      SYS_ALLERGY_VERIFICATION +
      "; (4) OUR AllergyIntolerance.verificationStatus carries a coding with that SAME code under that SAME system. Any non-'4.0.0' version, a .version on a different/wrong-system coding, or our side missing that status code -> GAP.",
    rationale:
      "Same server-applied ValueSet version artifact as the clinicalStatus rule, for the verification-status value set. No faithful EHI source authors a ValueSet version; our export omits it. Same status concept, server-stamped version only.",
    approval: {
      status: "approved",
      reviewer: "agent:reviewer",
      note: "NARROW our-side-absent server-stamp tolerance scoped to verificationStatus only and pinned to the literal '4.0.0' on a real status concept our side also emits. Injection-self-checked: a non-'4.0.0' version GAPs; a status code our side does not emit GAPs; the genuine '4.0.0'-vs-absent pairs tolerate.",
      rejectsRegression:
        "AllergyIntolerance.verificationStatus coding .version other than '4.0.0', a version on a non-status/wrong-system coding, or a status code our side does not emit -> GAP.",
    },
    hitCap: 4,
    verify: makeVerifyAllergyStatusVersion("verificationStatus", SYS_ALLERGY_VERIFICATION),
  },
];

// =============================================================================
// APPROVED BLESSED-VALUE RULES (pinned pairs)
// =============================================================================
export const BLESSED: BlessedRule[] = [
  {
    id: "blessed-practitioner-name-text-rammelkamp",
    tier: "blessed",
    kind: "blessed-value",
    scope: "Practitioner.name[].text",
    pinTargetValue: "Dr. Z Rammelkamp",
    pinOurValue: "Zoe L Rammelkamp",
    rationale:
      "Same Practitioner (SER 144590 both sides; CLARITY_SER.EXTERNAL_NAME = 'Zoe L Rammelkamp' exactly). Target is the privacy-masked form (title + first-initial + family); ours is the fuller truthful EHI name. No sibling reference inside a Practitioner resource to climb, so no mechanical tier can prove it -> per-case pinned attestation. Covers ONLY SER 144590; the other ~20 Practitioner.name[].text deltas stay GAP.",
    blessedBy: "agent:author",
    approval: {
      status: "provisional",
      reviewer: "agent:reviewer",
      note: "Identity confirmed (SER 144590 + CLARITY_SER). Pins BOTH values so any drift resurfaces as a GAP; covers exactly 1 row. De-masking a privacy-masked name to a full name is high-stakes -> stays provisional until a human co-signs.",
      rejectsRegression:
        "any Practitioner.name[].text other than the exact ('Dr. Z Rammelkamp','Zoe L Rammelkamp') pair (a different clinician, or our value drifting) -> GAP.",
    },
    signoff: "human-required",
    hitCap: 1,
  },
];

// =============================================================================
// DROPPED candidate rules (verdict REJECT) — recorded for audit, NEVER applied.
// =============================================================================
export const DROPPED = [
  // NOTE: "tolerate-documentreference-content-attachment-binary" was PENDING here in round-2a/2b
  // (awaiting Binary emission). In round-2c TODO #1 landed, so it is now an APPROVED MECHANICAL rule
  // (see MECHANICAL above) — moved OUT of this never-applied list. Its companion
  // "tolerate-documentreference-content-attachment-contenttype" was added at the same time.
  {
    id: "iso-ref-observation-specimen-by-accession",
    verdict: "reject",
    reason:
      "Accession is NOT a unique natural key for Specimen (many-to-one): target accession H613684 maps to 3 distinct Specimen ids, H237948 to 3 (incl. a Serum/Blood type split). Observations reference all 3 as separate referents, and 3 H613684-Serum specimens are byte-identical on every FHIR-visible field, so accession-equality would wrongly tolerate a re-point to a DIFFERENT specimen. SUPERSEDED by iso-ref-observation-specimen-by-accession-unique, which tolerates ONLY the unambiguous subset (accession resolving to exactly one Specimen per side, fail-closed via ctx.specimenAccessionUnique); the collision-group leaves it warns about correctly stay GAP.",
  },
  {
    id: "blessed-observation-code-text-bun-creat-ratio",
    verdict: "reject",
    reason:
      "Rationale is factually false: both BUN/Creat Observations DO carry an identical sibling join key in code.coding (Epic .768282/1510194 AND LOINC 3097-3) on both sides, so the equivalence is MECHANICALLY provable and must not be hand-blessed. The escalation rule says prefer MECHANICAL; a structural-variant predicate keyed on shared (system,code) coding intersection is the correct fix (future work). The code.text delta stays GAP until that mechanical rule is added; the separate coding-gap stays in its own bucket.",
  },
];

// =============================================================================
// REGISTRY accessors
// =============================================================================
export const RULES: Rule[] = [...MECHANICAL, ...BLESSED];

export function rulesForScope(scope: string): Rule[] {
  return RULES.filter((r) => r.scope === scope);
}

export const PROVISIONAL_BLESSINGS = BLESSED.filter((b) => b.approval.status === "provisional");
