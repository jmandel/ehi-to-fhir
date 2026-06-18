#!/usr/bin/env bun
/**
 * compare.ts — scorecard: generated FHIR (out/) vs target FHIR (fhir-target/).
 *
 *   bun compare.ts                 # summary table for every resource type
 *   bun compare.ts Condition       # detailed path-level diff for one type
 *
 * Resource IDs are Epic-opaque and will NOT match, so we compare by *shape*:
 * resource counts, the set of dotted field paths and their prevalence, and the
 * coding systems present at each path. A path at 100% target / 0% generated is a
 * concrete missing-field gap to close; the reverse is something we invented.
 */
import { profile, pct, type PathProfile } from "./lib/profile";
import { resolve } from "path";
import { readdirSync, existsSync } from "fs";

const TARGET_DIR = resolve(import.meta.dir, "fhir-target");
const OUT_DIR = resolve(import.meta.dir, "out");

function load(dir: string, type: string): any[] {
  const fs = require("fs");
  // merge <type>.json + <type>__*.json (sharded contributors)
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f === `${type}.json` || f.startsWith(`${type}__`))
    : [];
  const out: any[] = [];
  for (const f of files) {
    try { out.push(...JSON.parse(fs.readFileSync(resolve(dir, f), "utf8"))); } catch {}
  }
  return out;
}

const types = readdirSync(TARGET_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort();
const only = process.argv[2];

if (!only) {
  console.log("TYPE".padEnd(22), "TARGET", "GEN", " PATHS gen/tgt", " MISSING(tgt-only paths)");
  console.log("-".repeat(90));
  for (const t of types) {
    const tgt = profile(load(TARGET_DIR, t));
    const gen = profile(load(OUT_DIR, t));
    const tgtPaths = new Set(Object.keys(tgt.paths));
    const genPaths = new Set(Object.keys(gen.paths));
    const missing = [...tgtPaths].filter((p) => !genPaths.has(p)).length;
    console.log(
      t.padEnd(22),
      String(tgt.count).padStart(6),
      String(gen.count).padStart(4),
      `${String(genPaths.size).padStart(4)}/${String(tgtPaths.size).padStart(4)}`.padStart(13),
      String(missing).padStart(8)
    );
  }
  console.log("\nRun `bun compare.ts <Type>` for a path-level diff.");
  process.exit(0);
}

const tgt = profile(load(TARGET_DIR, only));
const gen = profile(load(OUT_DIR, only));
console.log(`\n=== ${only} ===  target=${tgt.count}  generated=${gen.count}\n`);

const allPaths = [...new Set([...Object.keys(tgt.paths), ...Object.keys(gen.paths)])].sort();
console.log("PATH".padEnd(58), "TGT%", "GEN%", "STATUS");
console.log("-".repeat(90));
for (const p of allPaths) {
  const tn = tgt.paths[p] ?? 0, gn = gen.paths[p] ?? 0;
  let status = "";
  if (tn > 0 && gn === 0) status = "<< MISSING";
  else if (tn === 0 && gn > 0) status = ">> EXTRA (not in target)";
  else if (Math.abs((tn / (tgt.count||1)) - (gn / (gen.count||1))) > 0.25) status = "~ prevalence differs";
  console.log(p.padEnd(58), pct(tn, tgt.count), pct(gn, gen.count), status);
}

// coding systems
const sysPaths = [...new Set([...Object.keys(tgt.systems), ...Object.keys(gen.systems)])].sort();
if (sysPaths.length) {
  console.log("\n--- coding systems by path (target | generated) ---");
  for (const p of sysPaths) {
    const t = Object.keys(tgt.systems[p] ?? {}).sort().join(", ") || "-";
    const g = Object.keys(gen.systems[p] ?? {}).sort().join(", ") || "-";
    const flag = t !== g ? "  <<< DIFF" : "";
    console.log(`  ${p}\n      tgt: ${t}\n      gen: ${g}${flag}`);
  }
}
