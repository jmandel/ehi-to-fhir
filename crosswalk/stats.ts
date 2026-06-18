#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./merge.ts";

const rows = parseCsv(readFileSync(join(import.meta.dir, "ALL.csv"), "utf8"))
  .filter((r) => !(r.length === 1 && r[0] === ""));
const header = rows[0];
const idx = (c: string) => header.indexOf(c);
const A = idx("area"), V = idx("ehi_verified"), CD = idx("concept_display"),
  EC = idx("epic_local_code"), TS = idx("target_system");
const data = rows.slice(1);

type Stat = {
  rows: number; verified: number;
  concepts: Set<string>; verifiedConcepts: Set<string>;
  systems: Set<string>;
};
const byArea = new Map<string, Stat>();
const get = (a: string) => {
  if (!byArea.has(a)) byArea.set(a, { rows: 0, verified: 0, concepts: new Set(), verifiedConcepts: new Set(), systems: new Set() });
  return byArea.get(a)!;
};
for (const r of data) {
  const s = get(r[A]);
  s.rows++;
  const cKey = r[EC] || r[CD];
  s.concepts.add(cKey);
  if ((r[V] || "").toLowerCase() === "yes") { s.verified++; s.verifiedConcepts.add(cKey); }
  if (r[TS]) s.systems.add(r[TS].replace(/^https?:\/\//, "").replace(/^www\./, ""));
}

let totRows = 0, totVer = 0;
const allConcepts = new Set<string>(), allVerConcepts = new Set<string>();
console.log("area | rows | verified | concepts | verConcepts | unanchored | systems");
for (const [a, s] of [...byArea].sort((x, y) => y[1].rows - x[1].rows)) {
  totRows += s.rows; totVer += s.verified;
  s.concepts.forEach((c) => allConcepts.add(a + "::" + c));
  s.verifiedConcepts.forEach((c) => allVerConcepts.add(a + "::" + c));
  console.log(`${a} | ${s.rows} | ${s.verified} | ${s.concepts.size} | ${s.verifiedConcepts.size} | ${s.rows - s.verified} | ${[...s.systems].join("; ")}`);
}
console.log("---");
console.log(`TOTAL rows=${totRows} verified=${totVer} unanchored=${totRows - totVer}`);
console.log(`distinct concepts=${allConcepts.size} verifiedConcepts=${allVerConcepts.size}`);
console.log(`row %bridgeable=${((totVer / totRows) * 100).toFixed(1)}%`);
console.log(`concept %bridgeable=${((allVerConcepts.size / allConcepts.size) * 100).toFixed(1)}%`);
