#!/usr/bin/env bun
/**
 * refcheck.ts — Layer-1 reference integrity for the generated bundle (id-independent).
 *
 * With synthetic ids, "same id as Epic" is the wrong test. What MUST hold is that our
 * own reference graph is internally sound: every reference resolves to a resource we emit,
 * and points at a type the FHIR element allows. This needs only out/ — no target, no id match.
 *
 *   bun tools/refcheck.ts            # report dangling refs, type violations, naked-display, graph summary
 *   bun tools/refcheck.ts --graph    # also print the edge histogram (sourceType.path -> targetType)
 *
 * Type expectations are a curated map of common R4 reference elements (extend as needed);
 * unknown paths are still resolvability-checked, just not type-checked.
 *
 * NAKED-DISPLAY check (enforces the SPECIFICITY PRINCIPLE going forward): a Reference-shaped
 * element that carries a `.display` (a human label) but NO resolvable `.reference` is a candidate
 * for replacement with the most specific REAL EHI entity, emitted as a resolvable reference. We
 * isolate Reference shape from CodeableConcept `coding[]` (which also has `.display`) by requiring
 * the node to NOT look like a Coding (no `.code`/`.system`) and to NOT sit at a `.coding` tail.
 */
import { readdirSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";

// OUT dir parameterizable (env OUT_DIR > default "out"), matching compare/classify.ts so the
// gate can be run against the baseline (out/) OR the crosswalk-enriched dir (out-crosswalk/).
const OUT = resolve(import.meta.dir, "..", process.env.OUT_DIR || "out");
const files = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "bundle.json") : [];
const resources: any[] = [];
for (const f of files) {
  try { const a = JSON.parse(readFileSync(resolve(OUT, f), "utf8")); if (Array.isArray(a)) resources.push(...a); } catch {}
}
const have = new Set(resources.filter((r) => r?.resourceType && r?.id).map((r) => `${r.resourceType}/${r.id}`));

// curated element -> allowed target resourceType(s). Keyed by the dotted path tail.
const EXPECT: Record<string, string[]> = {
  "subject": ["Patient", "Group"], "patient": ["Patient"], "beneficiary": ["Patient"],
  "encounter": ["Encounter"], "context": ["Encounter", "EpisodeOfCare"],
  "performer": ["Practitioner", "PractitionerRole", "Organization", "Patient", "RelatedPerson", "CareTeam"],
  "requester": ["Practitioner", "PractitionerRole", "Organization", "Patient", "Device"],
  "recorder": ["Practitioner", "PractitionerRole", "Patient", "RelatedPerson"],
  "asserter": ["Practitioner", "PractitionerRole", "Patient", "RelatedPerson"],
  "author": ["Practitioner", "PractitionerRole", "Organization", "Patient", "RelatedPerson", "Device"],
  "authenticator": ["Practitioner", "PractitionerRole", "Organization"],
  "custodian": ["Organization"], "serviceProvider": ["Organization"], "managingOrganization": ["Organization"],
  "insurer": ["Organization"], "payor": ["Organization", "Patient", "RelatedPerson"], "provider": ["Practitioner", "PractitionerRole", "Organization"],
  "location": ["Location"], "result": ["Observation"], "specimen": ["Specimen"],
  "hasMember": ["Observation", "QuestionnaireResponse", "MolecularSequence"], "derivedFrom": ["Observation", "DocumentReference", "Media", "QuestionnaireResponse", "MolecularSequence"],
  "basedOn": ["CarePlan", "ServiceRequest", "MedicationRequest", "ImmunizationRecommendation"],
  "partOf": ["Procedure", "Observation", "MedicationAdministration", "Encounter"],
  "medicationReference": ["Medication"], "coverage": ["Coverage"],
  "member": ["Practitioner", "PractitionerRole", "RelatedPerson", "Patient", "Organization", "CareTeam"],
  "participant": ["Practitioner", "PractitionerRole", "RelatedPerson", "Patient", "Device", "CareTeam", "HealthcareService", "Location"],
  "requestProvider": ["Practitioner", "PractitionerRole", "Organization"], "paymentIssuer": ["Organization"],
  "diagnosis": ["Condition"], "goal": ["Goal"], "addresses": ["Condition"], "focus": ["Resource"],
  "reasonReference": ["Condition", "Observation", "DiagnosticReport", "DocumentReference"],
};

type Edge = { src: string; path: string; ref: string };
const edges: Edge[] = [];
// naked-display: Reference-shaped node with a label but no resolvable reference.
type Naked = { srcType: string; path: string; display: string };
const naked: Naked[] = [];
const isCoding = (n: any) => typeof n.code === "string" || typeof n.system === "string";
function walk(node: any, srcKey: string, path: string) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) walk(x, srcKey, path); return; }
  if (typeof node.reference === "string") edges.push({ src: srcKey, path, ref: node.reference });
  // Attachment.url that points at an in-bundle Binary is a real reference edge even though
  // it is a plain string (not a Reference). Verify it resolves like any other edge so the
  // DocumentReference -> Binary link is covered by the gate (not silently invisible).
  if (typeof node.url === "string" && /^Binary\//.test(node.url))
    edges.push({ src: srcKey, path: path ? `${path}.url` : "url", ref: node.url });
  if (typeof node.reference !== "string" && typeof node.display === "string" && !isCoding(node) && (path.split(".").pop() || path) !== "coding")
    naked.push({ srcType: srcKey.split("/")[0], path, display: node.display });
  for (const [k, v] of Object.entries(node)) if (k !== "reference") walk(v, srcKey, path ? `${path}.${k}` : k);
}
for (const r of resources) if (r?.resourceType) walk(r, `${r.resourceType}/${r.id}`, "");

const dangling: Edge[] = [];
const typeViol: { e: Edge; got: string; want: string[] }[] = [];
const graph: Record<string, number> = {};
for (const e of edges) {
  if (e.ref.startsWith("#") || e.ref.startsWith("urn:")) continue; // contained / urn refs out of scope
  const [t] = e.ref.split("/");
  const tail = e.path.split(".").pop() || e.path;
  graph[`${e.src.split("/")[0]}.${e.path} -> ${t}`] = (graph[`${e.src.split("/")[0]}.${e.path} -> ${t}`] ?? 0) + 1;
  if (!have.has(e.ref)) dangling.push(e);
  const want = EXPECT[tail];
  if (want && !want.includes(t) && !want.includes("Resource")) typeViol.push({ e, got: t, want });
}

console.log(`resources: ${resources.length} | references: ${edges.length} | resolvable target ids: ${have.size}`);
console.log(`\n== DANGLING (${dangling.length}) — reference to a resource we don't emit ==`);
for (const d of dangling.slice(0, 40)) console.log(`  ${d.src}  .${d.path} -> ${d.ref}`);
if (dangling.length > 40) console.log(`  … +${dangling.length - 40} more`);
console.log(`\n== TYPE VIOLATIONS (${typeViol.length}) — referent type not allowed by the element ==`);
for (const v of typeViol.slice(0, 40)) console.log(`  ${v.e.src} .${v.e.path}: got ${v.got}, want ${v.want.join("|")}  (${v.e.ref})`);

// NAKED-DISPLAY — enforce the specificity principle: every {display} with no resolvable .reference.
const nakedGroups: Record<string, { count: number; samples: Set<string> }> = {};
for (const n of naked) {
  const key = `${n.srcType}.${n.path}`;
  (nakedGroups[key] ??= { count: 0, samples: new Set() }).count++;
  if (nakedGroups[key].samples.size < 4) nakedGroups[key].samples.add(n.display);
}
console.log(`\n== NAKED-DISPLAY (${naked.length}) — Reference element with a label but NO resolvable reference (specificity-principle candidates) ==`);
for (const [k, g] of Object.entries(nakedGroups).sort((a, b) => b[1].count - a[1].count))
  console.log(`  ${String(g.count).padStart(4)}  ${k}  ::  ${[...g.samples].join(" | ")}`);

if (process.argv.includes("--graph")) {
  console.log(`\n== REFERENCE GRAPH (edge histogram) ==`);
  for (const [k, n] of Object.entries(graph).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log(`\nSUMMARY: ${dangling.length} dangling / ${typeViol.length} type-violations / ${naked.length} naked-display`);
process.exit(dangling.length + typeViol.length > 0 ? 1 : 0);
