/**
 * lab.ts — Epic EHI → FHIR DiagnosticReport + Specimen + lab Observations.
 *
 * Spine: ORDER_PROC (order header) → ORDER_RESULTS (one row per analyte/component).
 * The target contains exactly the 9 lab/micro orders that carry structured results
 * AND are surfaced as reports (the COVID interp order 439060614 has a result row but
 * is NOT in the DiagnosticReport / lab-Observation target — it is excluded here).
 *
 *   DiagnosticReport  : 1 per resulted order (9).      id.diagnosticReport(ORDER_PROC_ID)
 *   Specimen          : 1 per resulted order (9).      id.specimen(ORDER_PROC_ID)
 *   Observation(labs) : 1 per ORDER_RESULTS row (46).  id.observation(`${ORDER_PROC_ID}-${LINE}`)
 *
 * Sources (verified against this specimen):
 *   ORDER_PROC                      — header: DESCRIPTION, type, status, CSN, AUTHRZING_PROV_ID,
 *                                     RESULT_LAB_ID(_LLB_NAME), SPECIMEN_TYPE_C_NAME
 *   ORDER_PROC_2 (ORDER_PROC_ID)    — specimen collect/receive times, COLLECTOR_IDN, EXTERNAL_ORD_ID
 *   ORDER_PROC_6 (ORDER_ID)         — *_FINAL/RSLT_UPD UTC instants (issued), PRIORITIZED_INST_*_DTTM
 *   ORDER_RAD_ACC_NUM (ORDER_PROC_ID) — ACC_NUM = specimen/filler accession (e.g. H258308)
 *   ORDER_RESULTS (ORDER_PROC_ID,LINE) — component value/range/flag/units/COMPON_LNC_ID
 *   ORD_RSLT_COMPON_ID (ORDER_ID,GROUP_LINE) — COMPON_SNOMED_CT for coded qualitative values
 *   LNC_DB_MAIN (RECORD_ID=COMPON_LNC_ID) — real LOINC code + long name
 *   ORDER_PROC_4 (ORDER_ID)         — PROC_LNC_ID = panel-level LOINC RECORD_ID (DR.code)
 *   INV_CLM_LN_ADDL (claim domain)  — PROC_OR_REV_CODE = CPT; billing PROC_ID → CLARITY_EAP
 *                                     .PROC_NAME = CPT display (DR.code; learned date binding)
 *   ORDER_PARENT_INFO (ORDER_ID)    — PARENT_ORDER_ID → SPEC_TYPE_SNOMED (Specimen SNOMED)
 *   ORDER_RES_COMMENT (ORDER_ID,LINE) — interpretive comment block (note)
 *   CLARITY_SER (PROV_ID)           — authorizing provider name
 *
 * DiagnosticReport.code.text = ORDER_PROC.DISPLAY_NAME (clean mixed-case; matches target).
 *
 * Recovered codings (joins documented on each loader — see gaps/lab.md):
 *   - DiagnosticReport.code.coding: CPT (claim domain, 7/9) + panel LOINC (PROC_LNC_ID, 7/9)
 *   - Observation.code.coding: real LOINC (own + cross-order COMPONENT_ID) + .768282 = COMPONENT_ID
 *   - Specimen.type.coding: SNOMED for Blood specimens only (parent SPEC_TYPE_SNOMED)
 *
 * Codings still absent from the export (confirmed, see gaps/lab.md):
 *   - Epic .737384.* proc/component alt-codes (no source table)
 *   - Specimen.type Epic .300 code (numeric _C stripped; label only ships)
 *   - CPT for Hep C 86803 / H. pylori 87338 (in no claim table); Stool SNOMED 119339001
 *   - all SNOMED/CPT/.768282 displays (no dictionary ships) → code-only
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { q, q1, parseEpicDateTime } from "../lib/db";
import { id, ref, patientRef, PATIENT_ID } from "../lib/ids";
import { emit, clean } from "../lib/gen";

const SYS_PLACER = "urn:oid:1.2.840.114350.1.13.283.2.7.2.798268";        // DR/Obs order id (placer)
const SYS_FILLER = "urn:oid:1.2.840.114350.1.13.283.2.7.3.798268.800";    // filler accession
const SYS_SPEC_ID = "urn:oid:1.2.840.114350.1.13.283.2.7.3.798268.320";   // Specimen.identifier accession
const SYS_ENC = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8";         // Encounter CSN
const SYS_CAT_EPIC = "urn:oid:1.2.840.114350.1.13.283.2.7.10.798268.30";  // Epic order-category
const SYS_CAT_HL7 = "http://terminology.hl7.org/CodeSystem/v2-0074";      // DiagnosticService section
const SYS_OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const SYS_LOINC = "http://loinc.org";
const SYS_UCUM = "http://unitsofmeasure.org";
const SYS_V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const SYS_CPT = "urn:oid:2.16.840.1.113883.6.12";                          // AMA CPT
const SYS_SNOMED = "http://snomed.info/sct";
const SYS_COMPON = "urn:oid:1.2.840.114350.1.13.283.2.7.2.768282";         // Epic component id (code = COMPONENT_ID)
const SYS_SPEC_SNOMED = "http://snomed.info/sct";

// Lab-panel CPT codes we will surface on DiagnosticReport.code (from claim/charge lines).
// Membership is a value filter only — the actual code+date come from the export.
const LAB_PANEL_CPTS = new Set(["80061", "80048", "83036", "80053", "85025", "80076", "84443"]);

const SENTINEL = "9999999";

type Row = Record<string, any>;

/**
 * The resulted lab/micro orders the target surfaces as reports, derived from the EHI:
 * orders that (a) carry at least one ORDER_RESULTS row AND (b) are real collected lab
 * orders (ORDER_CLASS_C_NAME = "Lab Collect"). This excludes the "Historical" COVID-19
 * documentation order (439060614), which has a result row but is an externally-recorded
 * historical entry, not a collected/reported lab. No hardcoded id list.
 */
function loadReportOrderIds(): string[] {
  const rows = q<Row>(
    `SELECT DISTINCT p.ORDER_PROC_ID
       FROM ORDER_PROC p
       JOIN ORDER_RESULTS r ON r.ORDER_PROC_ID = p.ORDER_PROC_ID
      WHERE p.ORDER_CLASS_C_NAME = 'Lab Collect'
      ORDER BY CAST(p.ORDER_PROC_ID AS INTEGER)`
  );
  return rows.map((r) => String(r.ORDER_PROC_ID));
}

/** Epic local "M/D/YYYY h:mm:ss AM" → naive ISO "YYYY-MM-DDTHH:MM:SS" (no zone). */
function naive(v: unknown): string | undefined {
  const iso = parseEpicDateTime(v);
  return iso && iso.includes("T") ? iso : undefined;
}
/** Epic UTC "M/D/YYYY h:mm:ss AM" → ISO instant with Z. */
function utc(v: unknown): string | undefined {
  const n = naive(v);
  return n ? `${n}Z` : undefined;
}

/**
 * Convert a local Epic datetime to a UTC instant, using the per-order offset
 * derived from the PRIORITIZED_INST local/UTC pair (Central time, DST-seasonal).
 * Falls back to naive+Z if no offset can be computed.
 */
function localToUtc(localVal: unknown, offsetMs: number | undefined): string | undefined {
  const n = naive(localVal);
  if (!n) return undefined;
  if (offsetMs === undefined) return `${n}Z`;
  const d = new Date(`${n}Z`);
  return new Date(d.getTime() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** offset to ADD to local-as-UTC to get true UTC (i.e. utc - local), in ms. */
function orderOffsetMs(op6: Row | undefined): number | undefined {
  const loc = naive(op6?.PRIORITIZED_INST_DTTM);
  const u = naive(op6?.PRIORITIZED_INST_UTC_DTTM);
  if (!loc || !u) return undefined;
  return new Date(`${u}Z`).getTime() - new Date(`${loc}Z`).getTime();
}

function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

/** Parse VALUE_NORMALIZED operator results like ">\x1090" → { comparator, value }. */
function parseComparator(v: unknown): { comparator: string; value: number } | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/[\u0000-\u001F ]/g, "").trim();
  const m = s.match(/^(>=|<=|>|<)\s*(-?[0-9.]+)$/);
  if (!m) return undefined;
  const value = Number(m[2]);
  if (!isFinite(value)) return undefined;
  return { comparator: m[1], value };
}

function ucumQty(value: number, unit?: string | null, comparator?: string) {
  const q: any = { value };
  if (comparator) q.comparator = comparator;
  if (unit && unit.trim()) {
    q.unit = unit.trim();
    q.system = SYS_UCUM;
    q.code = unit.trim();
  }
  return q;
}

// ---------------------------------------------------------------------------

function loadHeaders(orderIds: string[]): Map<string, Row> {
  const ph = orderIds.map(() => "?").join(",");
  const rows = q<Row>(
    `SELECT p.ORDER_PROC_ID, p.PROC_ID, p.DESCRIPTION, p.DISPLAY_NAME, p.ORDER_TYPE_C_NAME, p.PAT_ENC_CSN_ID,
            p.LAB_STATUS_C_NAME, p.AUTHRZING_PROV_ID, p.RESULT_LAB_ID, p.RESULT_LAB_ID_LLB_NAME,
            p.SPECIMEN_TYPE_C_NAME,
            p2.SPECIMN_TAKEN_TIME, p2.SPECIMEN_RECV_TIME, p2.COLLECTOR_IDN, p2.EXTERNAL_ORD_ID,
            p6.FIRST_FINAL_UTC_DTTM, p6.LAST_FINAL_UTC_DTTM, p6.RSLT_UPD_UTC_DTTM,
            p6.PRIORITIZED_INST_DTTM, p6.PRIORITIZED_INST_UTC_DTTM,
            acc.ACC_NUM,
            ser.PROV_NAME AS AUTH_PROV_NAME
       FROM ORDER_PROC p
       LEFT JOIN ORDER_PROC_2 p2 ON p2.ORDER_PROC_ID = p.ORDER_PROC_ID
       LEFT JOIN ORDER_PROC_6 p6 ON p6.ORDER_ID = p.ORDER_PROC_ID
       LEFT JOIN ORDER_RAD_ACC_NUM acc ON acc.ORDER_PROC_ID = p.ORDER_PROC_ID
       LEFT JOIN CLARITY_SER ser ON ser.PROV_ID = p.AUTHRZING_PROV_ID
      WHERE p.ORDER_PROC_ID IN (${ph})`,
    ...orderIds
  );
  const m = new Map<string, Row>();
  for (const r of rows) m.set(String(r.ORDER_PROC_ID), r);
  return m;
}

/** Date-only "M/D/YYYY" portion of an Epic datetime string. */
function dateOnly(v: unknown): string {
  const s = String(v ?? "");
  const i = s.indexOf(" ");
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * DiagnosticReport.code CPT — recovered from the BILLING/CLAIM domain, not the order domain.
 *
 * Root cause of the prior false-absence: the order tables ship no CPT (CLARITY_EAP has only
 * PROC_ID+PROC_NAME) and there is NO hard FK from a lab order to its charge. But the panel CPT
 * (e.g. 80061 Lipid) lives in INV_CLM_LN_ADDL.PROC_OR_REV_CODE keyed by service-date, and that
 * row's billing PROC_ID resolves through CLARITY_EAP.PROC_NAME to the exact target display
 * ("CHG LIPID PANEL"). We bind a claim CPT to a report order WITHOUT fabricating a CPT↔panel
 * map: we LEARN it from the data. On a service-date where exactly one report-order panel and
 * one panel-CPT co-occur (8/9/2018: Lipid+80061; 8/29/2022: BMP+80048) the binding is forced;
 * the remaining panel (A1c↔83036) falls out by elimination on the multi-panel dates. The learned
 * key is the order's stable panel PROC_ID, so it propagates to every date that panel appears.
 *
 * Returns ORDER_PROC_ID → { code, display }. Orders whose CPT never appears in any claim line
 * (Hep C 86803, H. pylori 87338 — absent from the whole export) get no entry → no coding.
 */
function loadOrderCpt(reportOrders: { ORDER_PROC_ID: string; PROC_ID: string; COLDATE: string }[]): Map<string, { code: string; display?: string }> {
  // Claim/charge lines carrying a panel CPT, with the EAP display for the billing PROC_ID.
  const claimRows = q<Row>(
    `SELECT a.PROC_OR_REV_CODE AS CPT, a.FROM_SVC_DATE AS SVC_DT, e.PROC_NAME AS DISPLAY
       FROM INV_CLM_LN_ADDL a
       LEFT JOIN CLARITY_EAP e ON e.PROC_ID = a.PROC_ID`
  );
  // date -> distinct list of {code, display} for panel CPTs only
  const cptsByDate = new Map<string, { code: string; display?: string }[]>();
  for (const c of claimRows) {
    const code = c.CPT == null ? "" : String(c.CPT).trim();
    if (!LAB_PANEL_CPTS.has(code)) continue;
    const d = dateOnly(c.SVC_DT);
    if (!d) continue;
    const list = cptsByDate.get(d) ?? [];
    if (!list.some((x) => x.code === code)) {
      list.push({ code, display: c.DISPLAY ? String(c.DISPLAY).trim() : undefined });
    }
    cptsByDate.set(d, list);
  }

  // orders grouped by collection date
  const ordersByDate = new Map<string, { ORDER_PROC_ID: string; PROC_ID: string }[]>();
  for (const o of reportOrders) {
    const list = ordersByDate.get(o.COLDATE) ?? [];
    list.push({ ORDER_PROC_ID: o.ORDER_PROC_ID, PROC_ID: String(o.PROC_ID) });
    ordersByDate.set(o.COLDATE, list);
  }

  // Learn panel PROC_ID -> CPT via iterative single-candidate elimination.
  const procToCpt = new Map<string, { code: string; display?: string }>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [d, ords] of ordersByDate) {
      const dayCpts = cptsByDate.get(d) ?? [];
      const usedCpts = new Set(
        ords.filter((o) => procToCpt.has(o.PROC_ID)).map((o) => procToCpt.get(o.PROC_ID)!.code)
      );
      const remOrders = ords.filter((o) => !procToCpt.has(o.PROC_ID));
      const remCpts = dayCpts.filter((c) => !usedCpts.has(c.code));
      if (remOrders.length === 1 && remCpts.length === 1) {
        procToCpt.set(remOrders[0].PROC_ID, remCpts[0]);
        changed = true;
      }
    }
  }

  const out = new Map<string, { code: string; display?: string }>();
  for (const o of reportOrders) {
    const m = procToCpt.get(String(o.PROC_ID));
    if (m) out.set(o.ORDER_PROC_ID, m);
  }
  return out;
}

/**
 * DiagnosticReport.code panel LOINC — ORDER_PROC_4.PROC_LNC_ID → LNC_DB_MAIN.LNC_CODE.
 * This is the panel-level (procedure) LOINC, distinct from the per-component COMPON_LNC_ID.
 * NULL for the two 2018 orders (matching the target, which omits a panel LOINC there).
 * Code-only (the target omits the display on the panel LOINC).
 */
function loadPanelLoinc(orderIds: string[]): Map<string, string> {
  const ph = orderIds.map(() => "?").join(",");
  const rows = q<Row>(
    `SELECT p4.ORDER_ID, l.LNC_CODE
       FROM ORDER_PROC_4 p4
       JOIN LNC_DB_MAIN l ON l.RECORD_ID = p4.PROC_LNC_ID
      WHERE p4.ORDER_ID IN (${ph}) AND p4.PROC_LNC_ID IS NOT NULL`,
    ...orderIds
  );
  const m = new Map<string, string>();
  for (const r of rows) if (r.LNC_CODE) m.set(String(r.ORDER_ID), String(r.LNC_CODE));
  return m;
}

/**
 * Specimen SNOMED type code — ORDER_PARENT_INFO links the resulted order to its placement
 * parent, which carries SPEC_TYPE_SNOMED.TYPE_SNOMED_CT. We emit it ONLY when the order's own
 * SPECIMEN_TYPE_C_NAME is "Blood": the parent SNOMED is always 119297000 (Blood = the draw
 * source), which is correct for a Blood specimen but would WRONGLY label the 6 Serum specimens.
 * Code-only — no SNOMED dictionary ships to resolve a display (target also omits it).
 * In this specimen this hits exactly order 945468372 → 119297000, matching the target.
 */
function loadSpecimenSnomed(orderIds: string[]): Map<string, string> {
  const ph = orderIds.map(() => "?").join(",");
  const rows = q<Row>(
    `SELECT p.ORDER_PROC_ID, sts.TYPE_SNOMED_CT
       FROM ORDER_PROC p
       JOIN ORDER_PARENT_INFO pi ON pi.ORDER_ID = p.ORDER_PROC_ID
       JOIN SPEC_TYPE_SNOMED sts ON sts.ORDER_ID = pi.PARENT_ORDER_ID
      WHERE p.ORDER_PROC_ID IN (${ph})
        AND p.SPECIMEN_TYPE_C_NAME = 'Blood'
        AND sts.TYPE_SNOMED_CT IS NOT NULL`,
    ...orderIds
  );
  const m = new Map<string, string>();
  for (const r of rows) if (r.TYPE_SNOMED_CT) m.set(String(r.ORDER_PROC_ID), String(r.TYPE_SNOMED_CT).trim());
  return m;
}

/**
 * Cross-order component LOINC fallback: COMPONENT_ID → a real LNC_CODE that the SAME component
 * carries on ANY other order. Used only when the result row's own COMPON_LNC_ID is NULL (the
 * 2018 components). Yields a valid analyte LOINC (e.g. LDL,Calculated 1557762 → 13457-7) from
 * the stable COMPONENT_ID mapping — derived, not fabricated.
 */
function loadComponentLoinc(): Map<string, string> {
  const rows = q<Row>(
    `SELECT r.COMPONENT_ID, l.LNC_CODE
       FROM ORDER_RESULTS r
       JOIN LNC_DB_MAIN l ON l.RECORD_ID = r.COMPON_LNC_ID
      WHERE r.COMPON_LNC_ID IS NOT NULL AND r.COMPONENT_ID IS NOT NULL
      GROUP BY r.COMPONENT_ID`
  );
  const m = new Map<string, string>();
  for (const r of rows) if (r.COMPONENT_ID && r.LNC_CODE) m.set(String(r.COMPONENT_ID), String(r.LNC_CODE));
  return m;
}

/**
 * Component proper-case display — crosswalk/lab.csv ships the proper-cased analyte label
 * (concept_display, e.g. "BUN/Creatinine Ratio") keyed by COMPONENT_ID for Observation.code
 * rows. We use it as Observation.code.text in place of the ALL-CAPS COMPONENT_ID_NAME ONLY
 * when a crosswalk row matches the component; otherwise the source text is kept. This is data
 * already in-repo (no fabrication). Returns COMPONENT_ID → concept_display.
 */
function loadComponentDisplay(): Map<string, string> {
  const m = new Map<string, string>();
  const path = resolve(import.meta.dir, "..", "crosswalk", "lab.csv");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return m;
  }
  const rows = parseCsv(text);
  if (rows.length === 0) return m;
  const header = rows[0];
  const iPath = header.indexOf("fhir_path");
  const iJoinCol = header.indexOf("ehi_join_column");
  const iCode = header.indexOf("epic_local_code");
  const iDisplay = header.indexOf("concept_display");
  if (iPath < 0 || iJoinCol < 0 || iCode < 0 || iDisplay < 0) return m;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row[iPath] !== "Observation.code") continue;
    if (row[iJoinCol] !== "COMPONENT_ID") continue;
    const code = (row[iCode] ?? "").trim();
    const disp = (row[iDisplay] ?? "").trim();
    if (!code || !disp) continue;
    if (!m.has(code)) m.set(code, disp); // first row wins; same display repeats across dual-code rows
  }
  return m;
}

/** Minimal RFC-4180 CSV parser (handles quoted fields with commas, quotes, newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function loadResults(orderId: string): Row[] {
  return q<Row>(
    `SELECT r.*, l.LNC_CODE, l.LNC_LONG_NAME,
            (SELECT c.COMPON_SNOMED_CT
               FROM ORD_RSLT_COMPON_ID c
              WHERE c.ORDER_ID = r.ORDER_PROC_ID
                AND CAST(c.GROUP_LINE AS INTEGER) = CAST(r.LINE AS INTEGER)
              ORDER BY CAST(c.VALUE_LINE AS INTEGER)
              LIMIT 1) AS COMPON_SNOMED_CT
       FROM ORDER_RESULTS r
       LEFT JOIN LNC_DB_MAIN l ON l.RECORD_ID = r.COMPON_LNC_ID
      WHERE r.ORDER_PROC_ID = ?
      ORDER BY CAST(r.LINE AS INTEGER)`,
    orderId
  );
}

/** All note texts for one component: COMPONENT_COMMENT + ORDER_RES_COMMENT block. */
function componentNotes(orderId: string, line: string, componentComment: unknown): any[] {
  const notes: any[] = [];
  if (componentComment !== null && componentComment !== undefined && String(componentComment).trim() !== "") {
    notes.push({ text: String(componentComment) });
  }
  const cmt = q<Row>(
    `SELECT RESULTS_CMT FROM ORDER_RES_COMMENT
      WHERE ORDER_ID = ? AND LINE = ?
      ORDER BY CAST(LINE_COMMENT AS INTEGER)`,
    orderId, line
  );
  if (cmt.length) {
    // Drop null/empty comment lines so a trailing-empty source row doesn't double the CRLF.
    const lines = cmt
      .map((c) => c.RESULTS_CMT)
      .filter((s) => s != null && String(s).trim() !== "");
    if (lines.length) {
      const text = lines.join("\r\n") + "\r\n";
      notes.push({ text });
    }
  }
  return notes;
}

// Order category: Lab orders → "Lab"; Microbiology → "Microbiology".
function epicCategory(h: Row) {
  const label = h.ORDER_TYPE_C_NAME === "Microbiology" ? "Microbiology" : "Lab";
  return label;
}

function observationCategory(h: Row): any[] {
  const epicLabel = epicCategory(h);
  return [
    {
      coding: [{ system: SYS_OBS_CAT, code: "laboratory", display: "Laboratory" }],
      text: "Laboratory",
    },
    {
      coding: [{ system: SYS_CAT_EPIC, code: epicLabel, display: epicLabel }],
      text: epicLabel,
    },
  ];
}

// ---------------------------------------------------------------------------

function build() {
  const reportOrderIds = loadReportOrderIds();
  const headers = loadHeaders(reportOrderIds);

  // Recovered code/derivation maps (joins documented on each loader).
  const reportMeta = reportOrderIds.map((oid) => {
    const h = headers.get(oid);
    return {
      ORDER_PROC_ID: oid,
      PROC_ID: h?.PROC_ID != null ? String(h.PROC_ID) : "",
      COLDATE: dateOnly(h?.SPECIMN_TAKEN_TIME),
    };
  });
  const cptByOrder = loadOrderCpt(reportMeta);
  const panelLoincByOrder = loadPanelLoinc(reportOrderIds);
  const specSnomedByOrder = loadSpecimenSnomed(reportOrderIds);
  const componentLoinc = loadComponentLoinc();
  const componentDisplay = loadComponentDisplay();

  const reports: any[] = [];
  const specimens: any[] = [];
  const observations: any[] = [];

  for (const orderId of reportOrderIds) {
    const h = headers.get(orderId);
    if (!h) continue;

    const offsetMs = orderOffsetMs(h);
    const csn = h.PAT_ENC_CSN_ID ? String(h.PAT_ENC_CSN_ID) : undefined;
    const acc = h.ACC_NUM ? String(h.ACC_NUM) : undefined;
    const epicLabel = epicCategory(h);

    // Effective: specimen collected time = PRIORITIZED_INST_UTC_DTTM (UTC).
    const effective = utc(h.PRIORITIZED_INST_UTC_DTTM)
      ?? localToUtc(h.SPECIMN_TAKEN_TIME, offsetMs);
    // Issued: result finalized instant (UTC). Prefer the FINAL instant; RSLT_UPD is the
    // result-CORRECTION time (10 days later on order 439060607) and would mis-date issued.
    const issued = utc(h.LAST_FINAL_UTC_DTTM) ?? utc(h.FIRST_FINAL_UTC_DTTM) ?? utc(h.RSLT_UPD_UTC_DTTM);

    const encounterRef = csn
      ? {
          reference: `Encounter/${id.encounter(csn)}`,
          identifier: { use: "usual", system: SYS_ENC, value: csn },
          display: epicLabel,
        }
      : undefined;

    const results = loadResults(orderId);

    // ---- Observations (one per result row) ----
    const resultRefs: any[] = [];
    for (const r of results) {
      const line = String(r.LINE);
      const obsId = id.observation(`${orderId}-${line}`);

      // Code: LOINC (real, from LNC_DB_MAIN) + Epic component code (.768282 = COMPONENT_ID)
      // + text from COMPONENT_ID_NAME. When the row's own COMPON_LNC_ID is NULL (the 2018
      // components), fall back to the SAME component's LOINC from another order (stable
      // COMPONENT_ID → LNC_DB_MAIN), which is a real analyte LOINC, not the row's value.
      const coding: any[] = [];
      if (r.LNC_CODE) {
        coding.push({ system: SYS_LOINC, code: String(r.LNC_CODE), display: r.LNC_LONG_NAME || undefined });
      } else if (r.COMPONENT_ID && componentLoinc.has(String(r.COMPONENT_ID))) {
        coding.push({ system: SYS_LOINC, code: componentLoinc.get(String(r.COMPONENT_ID))! });
      }
      // Epic component identifier: code = COMPONENT_ID, system fixed. Display absent in the
      // export (only the UPPERCASE COMPONENT_ID_NAME ships), so code-only.
      if (r.COMPONENT_ID) {
        coding.push({ system: SYS_COMPON, code: String(r.COMPONENT_ID) });
      }
      // code.text: prefer the crosswalk proper-cased label (concept_display, in-repo) when the
      // crosswalk row matches this component; otherwise keep the ALL-CAPS source COMPONENT_ID_NAME.
      const codeText =
        (r.COMPONENT_ID && componentDisplay.get(String(r.COMPONENT_ID))) ||
        r.COMPONENT_ID_NAME ||
        undefined;
      const code = clean({ coding, text: codeText });

      // Value: numeric → valueQuantity; operator (>90) → valueQuantity+comparator;
      // qualitative with a SNOMED result code (ORD_RSLT_COMPON_ID) → valueCodeableConcept;
      // otherwise plain qualitative text → valueString.
      let valueQuantity: any;
      let valueString: string | undefined;
      let valueCodeableConcept: any;
      const numVal = r.ORD_NUM_VALUE === SENTINEL ? undefined : toNum(r.ORD_NUM_VALUE);
      if (numVal !== undefined) {
        valueQuantity = ucumQty(numVal, r.REFERENCE_UNIT);
      } else {
        const cmp = parseComparator(r.VALUE_NORMALIZED);
        if (cmp) {
          valueQuantity = ucumQty(cmp.value, r.REFERENCE_UNIT, cmp.comparator);
        } else if (r.ORD_VALUE !== null && r.ORD_VALUE !== undefined && String(r.ORD_VALUE).trim() !== "") {
          const text = String(r.ORD_VALUE);
          // SNOMED result code lives in ORD_RSLT_COMPON_ID (no display ships — code only).
          if (r.COMPON_SNOMED_CT && String(r.COMPON_SNOMED_CT).trim() !== "") {
            valueCodeableConcept = clean({
              coding: [{ system: "http://snomed.info/sct", code: String(r.COMPON_SNOMED_CT).trim() }],
              text,
            });
          } else {
            valueString = text;
          }
        }
      }

      // Reference range. Parsed low/high → quantities; for a two-sided range the text
      // is reconstructed from the raw low/high strings (preserving trailing zeros) + unit,
      // as the target does. One-sided/operator/qualitative textual ranges ("<100", ">60",
      // ">40", "<30", "NR", "NEGATIVE FOR H PYLORI STOOL ANTIGEN") ship verbatim in
      // ORDER_RESULTS.REF_NORMAL_VALS (RAW_REF_VALS is null on those rows) — emit as
      // referenceRange[].text, matching the target exactly.
      const refLow = toNum(r.REFERENCE_LOW);
      const refHigh = toNum(r.REFERENCE_HIGH);
      const referenceRange: any[] = [];
      if (refLow !== undefined || refHigh !== undefined) {
        const rr: any = {};
        if (refLow !== undefined) rr.low = ucumQty(refLow, r.REFERENCE_UNIT);
        if (refHigh !== undefined) rr.high = ucumQty(refHigh, r.REFERENCE_UNIT);
        if (refLow !== undefined && refHigh !== undefined) {
          const unit = r.REFERENCE_UNIT && String(r.REFERENCE_UNIT).trim()
            ? ` ${String(r.REFERENCE_UNIT).trim()}`
            : "";
          rr.text = `${String(r.REFERENCE_LOW).trim()} - ${String(r.REFERENCE_HIGH).trim()}${unit}`;
        } else if (r.RAW_REF_VALS && String(r.RAW_REF_VALS).trim()) {
          rr.text = String(r.RAW_REF_VALS).trim();
        }
        referenceRange.push(rr);
      } else {
        const txt =
          (r.REF_NORMAL_VALS && String(r.REF_NORMAL_VALS).trim()) ||
          (r.RAW_REF_VALS && String(r.RAW_REF_VALS).trim());
        if (txt) referenceRange.push({ text: txt });
      }

      const obs = clean({
        resourceType: "Observation",
        id: obsId,
        basedOn: [
          {
            // Resolving reference to the placed order (ServiceRequest emitted in servicerequest.ts);
            // keep the placer identifier + display alongside. orderId is always a real order here.
            reference: `ServiceRequest/${id.serviceRequest(orderId)}`,
            type: "ServiceRequest",
            identifier: { use: "usual", system: SYS_PLACER, value: orderId },
            display: h.DESCRIPTION || undefined,
          },
        ],
        status: "final",
        category: observationCategory(h),
        code,
        subject: patientRef(),
        encounter: encounterRef,
        effectiveDateTime: effective,
        issued,
        valueQuantity,
        valueString,
        valueCodeableConcept,
        note: componentNotes(orderId, line, r.COMPONENT_COMMENT),
        specimen: acc
          ? ref("Specimen", id.specimen(orderId), `Specimen ${acc}`)
          : undefined,
        referenceRange,
      });
      observations.push(obs);

      const subIdn = r.RESULT_SUB_IDN ? String(r.RESULT_SUB_IDN) : "1";
      resultRefs.push(
        ref("Observation", obsId, `Component (${subIdn}): ${r.COMPONENT_ID_NAME || ""}`)
      );
    }

    // ---- DiagnosticReport ----
    const identifier: any[] = [
      {
        use: "official",
        type: {
          coding: [{ system: SYS_V2_0203, code: "PLAC", display: "Placer Identifier" }],
          text: "Placer Identifier",
        },
        system: SYS_PLACER,
        value: orderId,
      },
    ];
    if (acc) {
      // filler-with-system only when the external order id ships (the 2018 orders)
      if (h.EXTERNAL_ORD_ID) {
        identifier.push({
          use: "official",
          type: { coding: [{ system: SYS_V2_0203, code: "FILL", display: "Filler Identifier" }], text: "Filler Identifier" },
          system: SYS_FILLER,
          value: acc,
        });
      }
      identifier.push({
        use: "official",
        type: { coding: [{ system: SYS_V2_0203, code: "FILL", display: "Filler Identifier" }], text: "Filler Identifier" },
        value: acc,
      });
    }

    const performer: any[] = [];
    if (h.AUTHRZING_PROV_ID) {
      performer.push({
        reference: `Practitioner/${id.practitioner(h.AUTHRZING_PROV_ID)}`,
        type: "Practitioner",
        display: h.AUTH_PROV_NAME || undefined,
      });
    }
    if (h.RESULT_LAB_ID) {
      performer.push({
        reference: `Organization/${id.organization('LLB-' + h.RESULT_LAB_ID)}`,
        type: "Organization",
        display: h.RESULT_LAB_ID_LLB_NAME ? String(h.RESULT_LAB_ID_LLB_NAME).trim() : undefined,
      });
    }

    reports.push(
      clean({
        resourceType: "DiagnosticReport",
        id: id.diagnosticReport(orderId),
        identifier,
        basedOn: [
          {
            // Resolving reference to the placed order (ServiceRequest); orderId is real here.
            reference: `ServiceRequest/${id.serviceRequest(orderId)}`,
            type: "ServiceRequest",
            identifier: { use: "usual", system: SYS_PLACER, value: orderId },
            display: h.DESCRIPTION || undefined,
          },
        ],
        status: "final",
        category: [
          { coding: [{ system: SYS_CAT_EPIC, code: epicLabel }], text: epicLabel },
          { coding: [{ system: SYS_CAT_HL7, code: "LAB", display: "Laboratory" }], text: "Laboratory" },
        ],
        code: (() => {
          const drCoding: any[] = [];
          const cpt = cptByOrder.get(orderId);
          if (cpt) drCoding.push({ system: SYS_CPT, code: cpt.code, display: cpt.display });
          const panelLnc = panelLoincByOrder.get(orderId);
          if (panelLnc) drCoding.push({ system: SYS_LOINC, code: panelLnc });
          return clean({ coding: drCoding, text: h.DISPLAY_NAME || h.DESCRIPTION || undefined });
        })(),
        subject: patientRef(),
        encounter: encounterRef,
        effectiveDateTime: effective,
        issued,
        performer,
        result: resultRefs,
      })
    );

    // ---- Specimen ----
    const specIdentifier: any[] = [];
    if (acc) {
      specIdentifier.push({ system: SYS_SPEC_ID, value: acc });
      if (h.EXTERNAL_ORD_ID) specIdentifier.push({ system: SYS_FILLER, value: acc });
    }
    // Specimen.type: text from SPECIMEN_TYPE_C_NAME + SNOMED (code-only) recovered from the
    // placement-parent's SPEC_TYPE_SNOMED, but ONLY for genuinely Blood-typed specimens
    // (see loadSpecimenSnomed — the parent SNOMED is the Blood draw source, valid only there).
    const specSnomed = specSnomedByOrder.get(orderId);
    const specType = h.SPECIMEN_TYPE_C_NAME
      ? clean({
          coding: specSnomed ? [{ system: SYS_SPEC_SNOMED, code: specSnomed }] : [],
          text: String(h.SPECIMEN_TYPE_C_NAME),
        })
      : undefined;
    const receivedTime = localToUtc(h.SPECIMEN_RECV_TIME, offsetMs);
    const collectedTime = effective;
    specimens.push(
      clean({
        resourceType: "Specimen",
        id: id.specimen(orderId),
        identifier: specIdentifier,
        type: specType,
        subject: patientRef(),
        receivedTime,
        collection: {
          collector: h.COLLECTOR_IDN ? { display: String(h.COLLECTOR_IDN) } : undefined,
          collectedDateTime: collectedTime,
        },
      })
    );
  }

  return { reports, specimens, observations };
}

const { reports, specimens, observations } = build();
emit("DiagnosticReport", reports);
emit("Specimen", specimens);
emit("Observation", observations, "labs");
