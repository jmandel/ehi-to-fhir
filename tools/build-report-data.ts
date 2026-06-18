/**
 * build-report-data.ts — regenerate BOTH datasets the HTML report consumes, reproducibly:
 *   report/viewer/data.json       canonical view (answer-key / terminology bridge ON)
 *   report/viewer/data-lean.json  honest "raw export only" view (no bridge; coded concepts → text)
 *
 * It classifies each output dir, runs build-viewer for each, and leaves compare/LEDGER.json in its
 * canonical (answer-key) state. Run the generators first:
 *   bun build.ts --answer-key --embed-attachments     # writes out/ (lean) AND out-answerkey/
 * then:
 *   bun tools/build-report-data.ts
 *   bun report/build.ts                                # bundle the app
 */
import { resolve } from "path";
const ROOT = resolve(import.meta.dir, "..");
const run = (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) { console.error(new TextDecoder().decode(p.stderr)); throw new Error(cmd.join(" ") + " failed"); }
  return new TextDecoder().decode(p.stdout);
};

console.log("→ lean view (out/, no answer-key)");
run(["bun", "compare/classify.ts", "--out=out"], { EXCLUDE_SMARTDATA: "1" });
run(["bun", "tools/build-viewer.ts"], { VIEWER_OUR: "out", VIEWER_DATA: "report/viewer/data-lean.json" });
const lean = JSON.parse(await Bun.file(resolve(ROOT, "report/viewer/data-lean.json")).text()).summary;

console.log("→ canonical view (out-answerkey/, answer-key + attachments)");
run(["bun", "compare/classify.ts", "--out=out-answerkey"], { EXCLUDE_SMARTDATA: "1" });
run(["bun", "tools/build-viewer.ts"]); // defaults: out-answerkey + compare/LEDGER.json -> data.json
const canon = JSON.parse(await Bun.file(resolve(ROOT, "report/viewer/data.json")).text()).summary;

const faithful = (s: any) => Math.round(((s.exact + s.tolerated) / s.total) * 1000) / 10;
console.log("\n=== report data rebuilt ===");
console.log(`canonical : ${canon.exact}+${canon.tolerated}+${canon.gap}=${canon.total}  faithful ${faithful(canon)}%  ${canon.reconciles ? "OK" : "FAIL"}`);
console.log(`lean      : ${lean.exact}+${lean.tolerated}+${lean.gap}=${lean.total}  faithful ${faithful(lean)}%  ${lean.reconciles ? "OK" : "FAIL"}`);
console.log("compare/LEDGER.json left in canonical (answer-key) state. Next: bun report/build.ts");
