/**
 * build.ts — bundle the React/Zustand/D3 report into a single self-contained app.js that opens
 * over file:// (no server). data.json + content + summaries are import-inlined into the bundle.
 *
 *   bun report/build.ts
 *
 * Prereqs: a fresh report/viewer/data.json (bun tools/build-viewer.ts) and report/src/summaries.json.
 */
import { resolve } from "path";

const ROOT = resolve(import.meta.dir);
const out = await Bun.build({
  entrypoints: [resolve(ROOT, "src/app.tsx")],
  outdir: ROOT,
  naming: "app.js",
  minify: true,
  target: "browser",
  format: "iife", // classic script so report/index.html loads over file:// (ESM src is CORS-blocked there)
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!out.success) {
  console.error("BUILD FAILED");
  for (const m of out.logs) console.error(m);
  process.exit(1);
}
const art = out.outputs[0];
console.log(`built ${art.path} (${Math.round((await art.arrayBuffer()).byteLength / 1024)} KB)`);
console.log("open report/index.html in a browser (file:// is fine).");
