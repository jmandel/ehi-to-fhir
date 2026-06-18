#!/usr/bin/env bun
/**
 * build-skill-zip.ts — produce a 1:1 substitute "health-record-assistant" skill zip whose entire FHIR
 * bundle + attachment set are swapped to OUR synthesized (already-redacted) reconstruction from the EHI,
 * reshaped to exactly match the real export's data-file format.
 *
 * Real format (data/<provider>.json):
 *   { provider, patientDisplayName, patientBirthDate, fhir:{ <ResourceType>: Resource[] }, attachments:[
 *     { source:{resourceType,resourceId}, bestEffortFrom, bestEffortPlaintext,
 *       originals:[ {contentIndex, contentType, contentPlaintext, contentBase64, sourceFormat*, sourceType*, sourceProfiles} ] } ],
 *     fetchedAt }
 *   - DocumentReference.content[].attachment is stripped to {contentType, url}; content lives in attachments[].
 *
 * Swap rules:
 *   - fhir = every resource type in OUR bundle (Binary excluded — its bytes become attachments[]).
 *   - Communication = ONLY the two low-sensitivity threads the patient approved (CGM + Paxlovid).
 *   - attachments[] = one per OUR DocumentReference that has a note body, plaintext from our text/plain rendition.
 *
 *   bun tools/build-skill-zip.ts            (reads out-crosswalk/ + the real zip's SKILL.md for structure)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, process.env.SKILL_SRC || "out-crosswalk");
const REAL_SKILL_MD = process.env.REAL_SKILL_MD || "/tmp/hra-inspect/health-record-assistant/SKILL.md";
const OUT_ZIP = process.env.OUT_ZIP || resolve(process.env.HOME!, "Downloads/health-record-assistant-synthetic.zip");
const STAGE = "/tmp/hra-synth/health-record-assistant";
const KEEP_COMMUNICATIONS = ["comm-73255482", "comm-75160350", "comm-88901225", "comm-88909182"]; // CGM ask+refill, Paxlovid ask+RN reply

// ── load our resources ──
function load(type: string): any[] {
  const out: any[] = [];
  for (const f of readdirSync(SRC).filter((f) => f === `${type}.json` || f.startsWith(`${type}__`))) {
    try { const a = JSON.parse(readFileSync(resolve(SRC, f), "utf8")); if (Array.isArray(a)) out.push(...a); } catch {}
  }
  return out;
}
const allTypes = [...new Set(readdirSync(SRC).filter((f) => f.endsWith(".json") && f !== "bundle.json").map((f) => f.replace(/\.json$/, "").replace(/__.*$/, "")))];
const binaries = new Map<string, any>();
for (const b of load("Binary")) binaries.set(b.id, b);
const b64ToText = (s: string) => { try { return Buffer.from(s, "base64").toString("utf8"); } catch { return ""; } };
const stripRtf = (rtf: string) => rtf.replace(/\\par[d]?/g, "\n").replace(/\{\\[^{}]*\}/g, "").replace(/\\'[0-9a-f]{2}/gi, "").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "").replace(/\n{3,}/g, "\n\n").trim();

// ── build fhir map (every type except Binary; Communication filtered to the approved threads) ──
const fhir: Record<string, any[]> = {};
// seed with the clinical type set the skill expects (so empties are present), then fill from ours
for (const t of ["Patient","Observation","Condition","DiagnosticReport","CarePlan","ServiceRequest","AllergyIntolerance","CareTeam","Coverage","Device","Goal","DocumentReference","MedicationDispense","Immunization","MedicationStatement","Procedure","MedicationRequest","Encounter","Practitioner","Organization","Specimen","Medication"]) fhir[t] = [];
for (const t of allTypes) {
  if (t === "Binary") continue;
  let arr = load(t);
  if (t === "Communication") arr = arr.filter((c) => KEEP_COMMUNICATIONS.includes(c.id));
  fhir[t] = arr;
}

// ── attachments[] from our DocumentReferences; strip DocRef attachment to {contentType,url} ──
const attachments: any[] = [];
for (const dr of fhir.DocumentReference) {
  const contents = (dr.content || []).map((c: any) => c.attachment).filter((a: any) => a?.url?.startsWith("Binary/"));
  if (!contents.length) continue;
  const originals = contents.map((att: any, i: number) => {
    const bin = binaries.get(att.url.replace("Binary/", ""));
    const raw = bin?.data || "";
    const isPlain = (bin?.contentType || att.contentType) === "text/plain";
    const plaintext = isPlain ? b64ToText(raw) : stripRtf(b64ToText(raw));
    const typeCoding = (dr.type?.coding || [])[0] || {};
    return {
      contentIndex: i,
      contentType: bin?.contentType || att.contentType || "text/plain",
      contentPlaintext: plaintext || null,
      contentBase64: raw || null,
      sourceFormatCode: "urn:ihe:iti:xds:2017:mimeTypeSufficient",
      sourceFormatDisplay: "mimeType Sufficient",
      sourceFormatSystem: "http://ihe.net/fhir/ValueSet/IHE.FormatCode.codesystem",
      sourceProfiles: null,
      sourceTypeCode: typeCoding.code || null,
      sourceTypeDisplay: typeCoding.display || dr.type?.text || null,
      sourceTypeSystem: typeCoding.system || null,
      sourceTypeText: dr.type?.text || typeCoding.display || null,
    };
  });
  // prefer the text/plain rendition as bestEffort
  let best = originals.findIndex((o: any) => o.contentType === "text/plain");
  if (best < 0) best = 0;
  attachments.push({
    source: { resourceType: "DocumentReference", resourceId: dr.id },
    bestEffortFrom: best,
    bestEffortPlaintext: originals[best]?.contentPlaintext ?? null,
    originals,
  });
}
// now strip inline attachment payloads in the FHIR DocRefs to {contentType, url} (content lives in attachments[])
for (const dr of fhir.DocumentReference) {
  for (const c of dr.content || []) if (c.attachment) c.attachment = { contentType: c.attachment.contentType, url: c.attachment.url };
}

// ── top-level provider object (our redacted patient identity) ──
const pat = fhir.Patient[0] || {};
const nm = (pat.name || [])[0] || {};
const patientDisplayName = nm.given && nm.family ? `${nm.given.join(" ")} ${nm.family}` : (nm.text || "Unknown");
const provider = {
  provider: "UnityPoint Health",
  patientDisplayName,
  patientBirthDate: pat.birthDate || null,
  fhir,
  attachments,
  fetchedAt: new Date().toISOString(),
  _note: "SYNTHETIC: FHIR + attachments reconstructed from this patient's Epic EHI export (already redacted); a 1:1-shaped substitute for the real patient-portal download. Not Epic's live FHIR output.",
};

// ── PHI scrub (same mechanism as tools/build-viewer.ts): derive the patient's redaction preimages
// from the reference Patient at the exact paths our Patient tokenizes, then scrub every occurrence
// across the WHOLE provider object (fhir + attachments). This is required because our generators only
// tokenize the Patient demographic fields; sibling resources/fields can still carry the raw value. ──
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
function buildScrub() {
  const exact = new Set<string>(); const subs = new Set<string>();
  const tgtPath = resolve(ROOT, "fhir-target/Patient.json");
  if (existsSync(tgtPath) && pat) {
    const tgt = JSON.parse(readFileSync(tgtPath, "utf8"))[0];
    const ours = leavesByPath(pat), t = leavesByPath(tgt);
    for (const [path, ovals] of ours) {
      if (!ovals.some((v) => typeof v === "string" && /^\[REDACTED/.test(v))) continue;
      for (const tv of t.get(path) || []) {
        if (typeof tv !== "string" || !tv.trim() || /^\[REDACTED/.test(tv)) continue;
        if (/[\r\n]/.test(tv)) continue;
        exact.add(tv.trim());
        if (/line\[\]$/.test(path)) subs.add(tv.trim());
      }
    }
  }
  const subList = [...subs].sort((a, b) => b.length - a.length);
  const TOKEN = "[REDACTED]";
  const redactStr = (s: string): string => { if (exact.has(s.trim())) return TOKEN; let o = s; for (const p of subList) if (o.includes(p)) o = o.split(p).join(TOKEN); return o; };
  const walk = (n: any): any => typeof n === "string" ? redactStr(n) : Array.isArray(n) ? n.map(walk) : n && typeof n === "object" ? Object.fromEntries(Object.keys(n).map((k) => [k, walk(n[k])])) : n;
  return { walk, n: exact.size + subs.size };
}
const scrub = buildScrub();
const scrubbed = scrub.walk(provider);
console.log(`PHI scrub: ${scrub.n} patient preimage value(s) removed from the whole bundle`);

// ── stage + zip ──
rmSync("/tmp/hra-synth", { recursive: true, force: true });
mkdirSync(resolve(STAGE, "data"), { recursive: true });
mkdirSync(resolve(STAGE, "references"), { recursive: true });
if (existsSync(REAL_SKILL_MD)) copyFileSync(REAL_SKILL_MD, resolve(STAGE, "SKILL.md"));
writeFileSync(resolve(STAGE, "data/unitypoint-health.json"), JSON.stringify(scrubbed, null, 2));

const counts = Object.fromEntries(Object.entries(fhir).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
console.log("=== synthetic skill bundle ===");
console.log("patient:", patientDisplayName, "| DOB:", provider.patientBirthDate);
console.log("fhir types:", JSON.stringify(counts));
console.log("Communications kept:", fhir.Communication.length, "| attachments:", attachments.length, "| total note plaintext:", attachments.reduce((s, a) => s + (a.bestEffortPlaintext || "").length, 0), "chars");
console.log("staged at:", STAGE);
