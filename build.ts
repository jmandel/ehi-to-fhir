#!/usr/bin/env bun
/**
 * build.ts — run every domain generator in src/, then assemble out/bundle.json.
 * Each src/*.ts is a standalone script that writes out/<ResourceType>.json via
 * lib/gen.emit(). We just execute them, then collate.
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";

const SRC = resolve(import.meta.dir, "src");
const OUT = resolve(import.meta.dir, "out");

// OPT-IN: `bun build.ts --answer-key` runs the non-destructive answer-key
// enrichment pass AFTER the baseline build, populating out-answerkey/ (a SEPARATE
// dir) so baseline (out/) and enriched (out-answerkey/) both exist for WITH-vs-
// WITHOUT comparison. Plain `bun build.ts` stays baseline-only.
const APPLY_ANSWER_KEY = process.argv.includes("--answer-key");

// OPT-IN: `bun build.ts --embed-attachments` ALSO runs src/binary.ts to materialize
// out/Binary.json (the EXACT note/document bytes from the export) and includes those
// Binary resources in the bundle. It is the only thing that makes the
// DocumentReference attachment `url`s (Binary/<hash>) resolve in-bundle. The plain
// build stays lean (no Binary bytes) — and we drop any stale out/Binary.json so the
// lean bundle never carries it.
const EMBED_ATTACHMENTS = process.argv.includes("--embed-attachments");

// binary.ts is run explicitly (only when embedding) — never in the generic loop.
const scripts = existsSync(SRC)
  ? readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "binary.ts").sort()
  : [];
// Propagate the embed decision to the per-generator subprocesses (they can't see argv).
// documentreference.ts honors EMBED_ATTACHMENTS: it only points attachment.url at a
// Binary/<hash> when the Binary resources are actually being bundled — otherwise the lean
// build would carry 78 attachment.urls dangling at Binaries we deliberately omit.
const childEnv = { ...process.env, EMBED_ATTACHMENTS: EMBED_ATTACHMENTS ? "1" : "" };
for (const s of scripts) {
  const path = resolve(SRC, s);
  console.error(`\n### running ${s}`);
  const proc = Bun.spawnSync(["bun", path], { stdout: "inherit", stderr: "inherit", env: childEnv });
  if (proc.exitCode !== 0) console.error(`!!! ${s} exited ${proc.exitCode}`);
}

const BINARY_JSON = resolve(OUT, "Binary.json");
if (EMBED_ATTACHMENTS) {
  console.error(`\n### running binary.ts (--embed-attachments)`);
  const proc = Bun.spawnSync(["bun", resolve(SRC, "binary.ts")], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) console.error(`!!! binary.ts exited ${proc.exitCode}`);
} else if (existsSync(BINARY_JSON)) {
  // lean build: never carry Binary bytes in the bundle.
  rmSync(BINARY_JSON);
}

// assemble a FHIR collection bundle from everything in out/ (incl. <Type>__part.json)
const entries: any[] = [];
if (existsSync(OUT)) {
  for (const f of readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "bundle.json")) {
    const arr = JSON.parse(readFileSync(resolve(OUT, f), "utf8"));
    if (Array.isArray(arr))
      for (const r of arr)
        entries.push({
          // absolute fullUrl so relative references between resources resolve under validation
          fullUrl: r.resourceType && r.id ? `https://ehi-fhir.example/fhir/${r.resourceType}/${r.id}` : undefined,
          resource: r,
        });
  }
}
const bundle = { resourceType: "Bundle", type: "collection", entry: entries };
writeFileSync(resolve(OUT, "bundle.json"), JSON.stringify(bundle, null, 2));
console.error(`\nbundle.json: ${entries.length} resources`);

// STANDING GATE — reference integrity (non-fatal). Runs refcheck and prints one loud line so
// any regression (a new dangling ref, type violation, or naked-display reference element that the
// SPECIFICITY PRINCIPLE could resolve) is visible on every build. Does NOT change build exit code.
{
  const rc = Bun.spawnSync(["bun", resolve(import.meta.dir, "tools", "refcheck.ts")], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(rc.stdout);
  const m = out.match(/SUMMARY:\s*(\d+) dangling \/ (\d+) type-violations \/ (\d+) naked-display/);
  const [d, t, n] = m ? [m[1], m[2], m[3]] : ["?", "?", "?"];
  const ok = m && d === "0" && t === "0" && n === "0";
  console.error(
    ok
      ? "REFERENCE INTEGRITY: OK"
      : `REFERENCE INTEGRITY: ${d} dangling / ${t} type-violations / ${n} naked-display`,
  );
}

// OPT-IN ANSWER-KEY LAYER — only when --answer-key was passed. Runs the additive,
// idempotent enrichment pass that layers the recovered standard codings from
// crosswalk/ALL.csv onto the baseline output, writing ENRICHED copies to
// out-answerkey/. The baseline out/ (and its refcheck gate above) are untouched,
// so output gaps can be scored WITH vs WITHOUT the answer key.
if (APPLY_ANSWER_KEY) {
  console.error("\n### applying answer-key layer -> out-answerkey/");
  const ak = Bun.spawnSync(["bun", resolve(import.meta.dir, "tools", "apply-answer-key.ts")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (ak.exitCode !== 0) console.error(`!!! apply-answer-key exited ${ak.exitCode}`);
}
