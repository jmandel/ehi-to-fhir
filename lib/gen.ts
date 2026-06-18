/**
 * gen.ts — the contract every domain generator follows.
 *
 * A domain script (src/<domain>.ts) does:
 *
 *     import { emit } from "../lib/gen";
 *     emit("Condition", buildConditions());   // buildConditions(): any[]
 *
 * When run directly (`bun src/condition.ts`) it writes out/<ResourceType>.json
 * for each emitted type. emit() may be called more than once per script (a script
 * that produces MedicationRequest + Medication calls emit twice).
 *
 * When several generators contribute to ONE resource type (e.g. Observation is
 * sharded across vitals/labs/social/smartdata/survey), pass a `part` so each writes
 * out/<ResourceType>__<part>.json without clobbering the others. build.ts and
 * compare.ts merge `<ResourceType>.json` + `<ResourceType>__*.json`.
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const OUT_DIR = resolve(import.meta.dir, "..", "out");

export function emit(resourceType: string, resources: any[], part?: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const fname = part ? `${resourceType}__${part}.json` : `${resourceType}.json`;
  const path = resolve(OUT_DIR, fname);
  writeFileSync(path, JSON.stringify(resources, null, 2));
  console.error(`emit ${resourceType}${part ? ` [${part}]` : ""}: ${resources.length} → ${path}`);
}

/** Drop undefined/null/empty-array/empty-object fields recursively (FHIR-clean). */
export function clean<T>(obj: T): T {
  if (Array.isArray(obj)) {
    const arr = obj.map(clean).filter((v) => v !== undefined && v !== null);
    return arr as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const cv = clean(v);
      if (cv === undefined || cv === null) continue;
      if (Array.isArray(cv) && cv.length === 0) continue;
      if (typeof cv === "object" && !Array.isArray(cv) && Object.keys(cv).length === 0) continue;
      out[k] = cv;
    }
    return out;
  }
  if (obj === "") return undefined as unknown as T;
  return obj;
}
