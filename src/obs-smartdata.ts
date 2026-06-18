/**
 * obs-smartdata.ts — FHIR Observation generator for the "obs-smartdata" domain.
 *
 * SCOPE: ONLY category=smartdata Observations.
 *   emit("Observation", arr, "smartdata") -> out/Observation__smartdata.json
 *
 * WHAT THE TARGET WANTS (fhir-target/Observation.json, 118 smartdata rows):
 *   Every one is a SmartData *element* value (a SmartForm / SmartTool finding) —
 *     code.coding[] = { system: urn:oid:1.2.840.114350.1.13.283.2.7.2.727688,
 *                       code: "EPIC#<SDI>", display }  (+ a http://snomed.info/sct coding on 96)
 *     code.text     = the full element path ("FINDINGS - PHYSICAL EXAM - ... - NO FOCAL DEFICIT")
 *     category[]    = [smartdata (open.epic observation-category), exam (hl7 observation-category)]
 *     status        = "unknown"
 *     focus[]       -> DocumentReference (the note the element was filed on)
 *     issued        = the element's filed instant
 *     performer[]   -> Practitioner (CUR_VALUE_USER_ID)
 *     component[]   = { code.text: "Line <n>", valueBoolean | valueString }
 *
 * WHERE THAT DATA LIVES IN AN EHI EXPORT (per the SmartData field guide):
 *   The generic SmartData element store:
 *     SMRTDTA_ELEM_DATA            — one row per filed value (ELEMENT_ID = the SDI,
 *                                    CONTEXT_NAME, RECORD_ID_VARCHAR / CONTACT_SERIAL_NUM,
 *                                    CUR_VALUE_USER_ID, CUR_VALUE_DATETIME)
 *     V_EHI_SMRTDTA_ELEM_VAL_EXT   — the value carrier (HLV_ID, LINE,
 *                                    SMRTDTA_ELEM_VALUE_EXTERNAL, COLUMN_DESCRIPTOR)
 *     CLARITY_CONCEPT              — ELEMENT_ID -> NAME/display + the urn:oid concept code
 *
 * SHIPPED IN THIS SPECIMEN? NO — proven falsifiably (see gaps/obs-smartdata.md):
 *   - find-concept "smartdata"/"SMRTDTA" classify SMRTDTA_ELEM_DATA,
 *     V_EHI_SMRTDTA_ELEM_VAL_EXT, CLARITY_CONCEPT, SMRTDTA_ELEM_AUTH, ELEM_VAL_PREV,
 *     LAB_CASE_SNOMED ALL as "documented but EMPTY/not-shipped" (0 populated tables).
 *   - `bun lib/q.ts "SELECT COUNT(*) FROM <each>"` errors "no such table" for all of them.
 *   - Cross-domain value scans over raw/EHITables/*.tsv return 0 hits:
 *       --grep 'EPIC#'                                    (target code system)
 *       --grep '31000134232|PEAB0102|PENE0001'           (target SDI codes)
 *       --grep '162718006|102599008|246875002|163600007' (target SNOMED codes)
 *       --grep 'NO FOCAL DEFICIT|CVA TENDERNESS'          (target element-path text)
 *   The 118 target resources have no backing rows/bytes anywhere in the export.
 *
 *   The ONLY shipped SmartData-adjacent store is SDD (Social Drivers Data):
 *   SDD_DATA / SDD_ENTRIES / V_EHI_SDD_ENTRY_INTERPRETATION / SDOH_DOM_CONFIG_INFO.
 *   That is the SDOH risk-screening store — a different concept (domain-level concern
 *   levels, no EPIC# SDI, no DocumentReference focus, no per-line boolean components).
 *   None of the 118 category=smartdata targets correspond to an SDD row, so SDD is NOT a
 *   substitute source for this shard. (If SDD ever maps to FHIR it belongs to a
 *   social-history Observation shard, not here.)
 *
 * RESULT: this shard is honestly EMPTY for this specimen. We still build defensively from
 * the real source so that a future export which DOES ship the generic store auto-populates
 * without code changes — but we NEVER fabricate the EPIC# code, SNOMED coding, display,
 * value, focus, performer, or issued instant when the rows are absent. A blank beats an
 * invention (mapping principle 4). See gaps/obs-smartdata.md.
 */
import { q, tableHasRows, columnsOf, parseEpicDateTime } from "../lib/db";
import { id, ref, patientRef } from "../lib/ids";
import { emit, clean } from "../lib/gen";

// The Epic SmartData concept code system (constant across the target's 118 rows).
const SDI_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.727688";

function buildSmartDataObservations(): any[] {
  // Defensive: only attempt if the generic SmartData element store actually shipped.
  // In this specimen it did not (see header), so this returns [] honestly.
  if (!tableHasRows("SMRTDTA_ELEM_DATA") || !tableHasRows("V_EHI_SMRTDTA_ELEM_VAL_EXT")) {
    return [];
  }

  // ---- The block below is the intended mapping for an export that DOES ship the store.
  // It is column-guarded (columnsOf) so it cannot crash on a partial schema; it never runs
  // in this specimen. It is intentionally conservative: emit a code/coding ONLY from
  // CLARITY_CONCEPT (the real concept master), value/component ONLY from the value view.
  const dataCols = new Set(columnsOf("SMRTDTA_ELEM_DATA"));
  const valCols = new Set(columnsOf("V_EHI_SMRTDTA_ELEM_VAL_EXT"));
  const hasConcept = tableHasRows("CLARITY_CONCEPT");

  const rows = q<Record<string, any>>(`SELECT * FROM SMRTDTA_ELEM_DATA`);
  const out: any[] = [];

  for (const r of rows) {
    const elementId = r.ELEMENT_ID;
    if (!elementId) continue;

    // Concept meaning (display + urn:oid code) — only from the real master.
    let coding: any[] | undefined;
    let codeText: string | undefined;
    if (hasConcept) {
      const c = q<Record<string, any>>(
        `SELECT * FROM CLARITY_CONCEPT WHERE CONCEPT_ID = ?`,
        elementId,
      )[0];
      if (c) {
        codeText = c.NAME ?? undefined;
        coding = [clean({ system: SDI_OID, code: elementId, display: c.NAME })];
      }
    }

    // Values / components — from the export value view, on (HLV_ID, LINE).
    const hlvKey = dataCols.has("HLV_ID") ? r.HLV_ID : undefined;
    const components: any[] = [];
    if (hlvKey !== undefined && valCols.has("HLV_ID")) {
      const vals = q<Record<string, any>>(
        `SELECT * FROM V_EHI_SMRTDTA_ELEM_VAL_EXT WHERE HLV_ID = ? ORDER BY CAST(LINE AS INTEGER)`,
        hlvKey,
      );
      for (const v of vals) {
        const ext = v.SMRTDTA_ELEM_VALUE_EXTERNAL;
        if (ext === null || ext === undefined || ext === "") continue;
        const line = v.LINE != null ? `Line ${v.LINE}` : undefined;
        // boolean-ish externalized values render as Yes/No in Epic; preserve as string
        // unless unambiguously boolean. We do NOT guess a type we can't confirm.
        components.push(clean({ code: { text: line }, valueString: String(ext) }));
      }
    }

    out.push(
      clean({
        resourceType: "Observation",
        id: id.observation(`smrtdta-${r.HLV_ID ?? elementId}`),
        status: "unknown",
        category: [
          {
            coding: [
              {
                system: "http://open.epic.com/FHIR/StructureDefinition/observation-category",
                code: "smartdata",
                display: "SmartData",
              },
            ],
            text: "SmartData",
          },
        ],
        code: { coding, text: codeText },
        subject: patientRef(),
        issued: parseEpicDateTime(dataCols.has("CUR_VALUE_DATETIME") ? r.CUR_VALUE_DATETIME : undefined),
        performer:
          dataCols.has("CUR_VALUE_USER_ID") && r.CUR_VALUE_USER_ID
            ? [ref("Practitioner", id.practitioner(r.CUR_VALUE_USER_ID))]
            : undefined,
        component: components,
      }),
    );
  }
  return out;
}

const observations = buildSmartDataObservations();
emit("Observation", observations, "smartdata");
