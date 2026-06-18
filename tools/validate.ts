#!/usr/bin/env bun
/**
 * validate.ts — run the official HL7 FHIR R4 validator over a generated resource type.
 *
 *   bun tools/validate.ts Communication        # validates out/Communication.json (+ __parts)
 *   bun tools/validate.ts out/Foo.json         # validates an explicit file (array or single resource)
 *
 * Wraps the resource array into a collection Bundle (the validator needs a FHIR
 * resource, not a bare JSON array), runs validator_cli.jar with -tx n/a (no external
 * terminology server — avoids network flakiness; code bindings become warnings not
 * errors, which is the right posture for our best-effort codings), parses the
 * OperationOutcome, and prints errors/warnings grouped. Exit code = # of errors.
 */
import { resolve } from "path";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";

const ROOT = resolve(import.meta.dir, "..");
const JAR = resolve(import.meta.dir, "validator_cli.jar");
const arg = process.argv[2];
if (!arg) { console.error("usage: bun tools/validate.ts <ResourceType | path.json>"); process.exit(2); }
if (!existsSync(JAR)) { console.error(`validator jar not found at ${JAR}`); process.exit(2); }

function loadType(type: string): any[] {
  const dir = resolve(ROOT, "out");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f === `${type}.json` || f.startsWith(`${type}__`)) : [];
  const out: any[] = [];
  for (const f of files) out.push(...JSON.parse(readFileSync(resolve(dir, f), "utf8")));
  return out;
}

let resources: any[];
if (arg.endsWith(".json")) {
  const j = JSON.parse(readFileSync(resolve(ROOT, arg), "utf8"));
  resources = Array.isArray(j) ? j : [j];
} else {
  resources = loadType(arg);
}
if (resources.length === 0) { console.error(`no resources found for "${arg}"`); process.exit(2); }

// fullUrl on every entry so the validator can resolve the relative references
// between our resources (otherwise it flags every Reference, drowning real issues).
const bundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((r) => ({
    fullUrl: r.resourceType && r.id ? `https://ehi-fhir.example/fhir/${r.resourceType}/${r.id}` : undefined,
    resource: r,
  })),
};
const dir = mkdtempSync(resolve(tmpdir(), "fhirval-"));
const inFile = resolve(dir, "bundle.json");
const outFile = resolve(dir, "report.json");
writeFileSync(inFile, JSON.stringify(bundle));

console.error(`validating ${resources.length} ${arg} resource(s) ...`);
// Load the US Core R4 IG so US Core extensions (us-core-race/ethnicity/birthsex) and its
// valuesets RESOLVE (no resource declares meta.profile, so this adds definitions only — it
// does NOT force profile conformance). -tx n/a keeps terminology offline. Remaining
// "extension could not be found" errors are then only Epic-proprietary (open.epic.com) ones.
const proc = Bun.spawnSync(
  ["java", "-Xmx4g", "-jar", JAR, inFile, "-version", "4.0.1", "-ig", "hl7.fhir.us.core.r4#8.0.1", "-tx", "n/a", "-output", outFile],
  { stdout: "pipe", stderr: "pipe" }
);

if (!existsSync(outFile)) {
  console.error("validator produced no report; raw output:");
  console.error(new TextDecoder().decode(proc.stdout));
  console.error(new TextDecoder().decode(proc.stderr));
  process.exit(2);
}
const oo = JSON.parse(readFileSync(outFile, "utf8"));
const issues = oo.issue ?? [];
const bySev: Record<string, any[]> = {};
for (const i of issues) (bySev[i.severity] ??= []).push(i);

const errors = (bySev.error ?? []).concat(bySev.fatal ?? []);
const warnings = bySev.warning ?? [];
const loc = (i: any) => (i.expression?.[0] ?? i.location?.[0] ?? "");
console.log(`\n=== ${arg}: ${errors.length} error(s), ${warnings.length} warning(s), ${(bySev.information ?? []).length} info ===`);
for (const i of errors) console.log(`  ERROR  ${loc(i)}\n         ${i.diagnostics ?? i.details?.text}`);
// warnings are often just "unknown code / can't validate against tx" — show a capped sample
for (const i of warnings.slice(0, 25)) console.log(`  warn   ${loc(i)}: ${(i.diagnostics ?? i.details?.text ?? "").slice(0, 160)}`);
if (warnings.length > 25) console.log(`  ... +${warnings.length - 25} more warnings`);
process.exit(errors.length);
