# Lab domain gaps — DiagnosticReport, Specimen, Observation (category=laboratory)

Domain spine: `ORDER_PROC` (header) → `ORDER_RESULTS` (one row per analyte). Exactly the
9 lab/micro orders that carry structured results AND are surfaced as reports are emitted.
The COVID interp order `439060614` has a single result row but is NOT in the target
DiagnosticReport / lab-Observation set, so it is excluded (giving 9 DR, 9 Specimen, 46 Obs).

Counts reproduced exactly: DiagnosticReport 9/9, Specimen 9/9, Observation(labs) 46/46.

## DiagnosticReport

- **`code.coding[]` CPT — RECOVERED (was false-absence).** The procedure CPT
  (`urn:oid:2.16.840.1.113883.6.12`, e.g. 80061 Lipid, 80048 BMP, 83036 A1c) is NOT in the
  order domain (no order table ships a CPT; the order's `PROC_ID` 684/678/828 is a different
  ID space from billing). It lives in the BILLING domain: `INV_CLM_LN_ADDL.PROC_OR_REV_CODE`
  (also `SVC_LN_INFO.LN_PROC_CD`) keyed by `FROM_SVC_DATE`. The CPT *display* ("CHG LIPID
  PANEL") is recovered from that claim row's billing `PROC_ID` (19732/19722/20302) →
  `CLARITY_EAP.PROC_NAME` — matching the target display string exactly.
  **Linkage (no hard FK exists):** there is no order→charge FK anywhere, so we bind a claim
  CPT to a report order WITHOUT fabricating a CPT↔panel table — we *learn* the mapping from
  the data. On a service-date where exactly one report-order panel and one panel-CPT co-occur
  (8/9/2018 Lipid+80061; 8/29/2022 BMP+80048) the binding is forced; A1c↔83036 falls out by
  elimination on the multi-panel dates (9/28/2023, 12/4/2025). The learned key is the order's
  stable panel `PROC_ID`, so it propagates across dates. See `loadOrderCpt()`. Covers 7/9
  orders. **Still absent:** Hep C Ab (945468372, target CPT 86803) and H. pylori (439060607,
  target 87338) — `find-concept --grep '\b86803\b'` and `'\b87338\b'` return 0 tables; those
  CPTs are in NO claim/charge table, so those two DRs carry no CPT (matching what IS derivable).
- **`code.coding[]` panel LOINC — RECOVERED (was wrongly "confirmed-absent").** The panel-level
  LOINC (BMP 24321-2, Lipid 24331-1, A1c 4548-4, Hep C 16128-1) is reachable via
  `ORDER_PROC_4.PROC_LNC_ID` (keyed by `ORDER_ID`) → `LNC_DB_MAIN.RECORD_ID` → `LNC_CODE`.
  The prior audit only checked component LOINCs (`COMPON_LNC_ID`) and missed the
  *procedure*-level `PROC_LNC_ID` column. Recovered on 7/9 orders, matching the target codes
  exactly; NULL for the two 2018 orders (439060606/439060607), matching the target which omits
  a panel LOINC there. Code-only (target omits the panel-LOINC display). See `loadPanelLoinc()`.
- **`code.coding[]` Epic proc alt-codes (`urn:oid:...737384.*`, e.g. LIPID/LIPIDP) — CONFIRMED ABSENT.**
  The target carries ~150 Epic-internal proc mnemonics. `find-concept --grep '\bLIPIDP\b'`
  over all raw TSVs returns 0 tables; `CLARITY_EAP` ships only `PROC_ID`+`PROC_NAME` (no
  mnemonic/alt-code column). Not emitted.
- **Emitted `code.text`** = `ORDER_PROC.DISPLAY_NAME` (clean mixed-case, e.g. "Lipid panel"),
  matching the target on all 9 reports (UPPERCASE `DESCRIPTION`/`PROC_NAME` is fallback only).

## Specimen

- **`type.coding[]` SNOMED — PARTIALLY RECOVERED (Blood only).** The prior claim that
  `SPEC_TYPE_SNOMED` is unlinked to the resulted orders was wrong: `ORDER_PARENT_INFO` links
  each resulted order to its *placement* parent, and the parent carries
  `SPEC_TYPE_SNOMED.TYPE_SNOMED_CT`. BUT the parent's SNOMED is always 119297000 (= Blood, the
  draw source), so it is only correct for genuinely Blood-typed specimens. We therefore emit it
  ONLY when `SPECIMEN_TYPE_C_NAME = 'Blood'` AND the parent SNOMED is non-null — which hits
  exactly order 945468372 → 119297000, matching the target's one Blood specimen exactly. For
  the 6 Serum specimens emitting the parent's Blood SNOMED would contradict the type (Serum,
  target SNOMED null), so we suppress it. For the other Blood order (439060606) and the Stool
  order (439060607) the parent SNOMED is null (matching the target's null there). Stool SNOMED
  119339001 that the target assigns is absent everywhere: `find-concept --grep '119339001'` = 0
  tables. Code-only: no SNOMED dictionary ships to resolve the display ("Blood specimen
  (specimen)"); `find-concept --grep 'Blood specimen'` = 0 tables. See `loadSpecimenSnomed()`.
- **`type.coding[]` Epic `.300` code (e.g. 100230=Serum, 54=Stool, 188=Blood) — CONFIRMED ABSENT.**
  The `.300` code is the numeric `_C` behind `SPECIMEN_TYPE_C_NAME`, which the export ships
  pre-resolved to the label only. `find-concept --grep '\b100230\b'` over all raw TSVs returns
  0 tables. Not emitted. **Emitted:** `type.text` = `SPECIMEN_TYPE_C_NAME`.
- **Second identifier system `.798268.800` is conditional.** Emitted only when
  `ORDER_PROC_2.EXTERNAL_ORD_ID` is present (the two 2018 orders), matching the target. The
  always-present accession (`.798268.320`) is `ORDER_RAD_ACC_NUM.ACC_NUM`.

## Observation (laboratory)

- **`basedOn[].reference` (ServiceRequest) — CROSS-DOMAIN / STRUCTURAL GAP.** Target points
  `basedOn` at a `ServiceRequest` resource (45/46) via an opaque Epic FHIR id. There is no
  ServiceRequest target, no ServiceRequest minter in `lib/ids`, and no generator produces
  one, so a `reference` would dangle. **Emitted:** `basedOn[].identifier` (the placer order
  id, system `.2.798268`) + `display` = `ORDER_PROC.DESCRIPTION` — the same shape the target
  itself uses for the one identifier-form `basedOn` (H. pylori order 439060607). This is the
  honest, internally-consistent representation of the ordering link.
- **`valueCodeableConcept` SNOMED *display* for 1 qualitative result — CODING GAP (code IS present).**
  The Hep C Ab result ("NONREACTIVE") is a SNOMED-coded `valueCodeableConcept`
  (`http://snomed.info/sct` 131194007) in the target. That SNOMED code **is** in the export:
  `ORD_RSLT_COMPON_ID` has one row (ORDER_ID=945468372, GROUP_LINE=1, VALUE_LINE=1,
  COMPON_SNOMED_CT=131194007), joined to `ORDER_RESULTS` on (ORDER_ID=ORDER_PROC_ID,
  GROUP_LINE=LINE). **Emitted:** `valueCodeableConcept = {coding:[{system:'http://snomed.info/sct',
  code:'131194007'}], text:'NONREACTIVE'}` — matching the target's coding and text exactly.
  The only gap is the SNOMED *display* (no SNOMED dictionary ships to resolve one — searched:
  no table maps a SNOMED code to a display; `find-concept` for SNOMED dictionaries yields none,
  and `find-concept --grep '131194007'` returns only `ORD_RSLT_COMPON_ID`, never a display);
  the target also omits the display, so this is a no-op in practice. Qualitative results with no
  `ORD_RSLT_COMPON_ID` row (e.g. H. pylori order 439060607) stay `valueString` — matching the
  target.
- **Component LOINC for the NULL-LOINC rows — RECOVERED cross-order.** Most components resolve
  a LOINC via `LNC_DB_MAIN.RECORD_ID = ORDER_RESULTS.COMPON_LNC_ID` (code + long-name display).
  The 2018 lipid components (order 439060606) have `COMPON_LNC_ID = NULL` on their own rows, so
  the prior audit called the LOINC unreachable. It is recoverable cross-order: the stable
  `COMPONENT_ID` carries a real LNC_CODE on OTHER orders. `loadComponentLoinc()` builds
  `COMPONENT_ID → LNC_CODE` from every populated row and fills the NULL rows: Cholesterol
  (1557760)→2093-3, Triglycerides (1552156)→2571-8, LDL,Calculated (1557762)→13457-7,
  Chol/HDL Ratio (1557763)→9830-1. HDL (1557761) has no LOINC on ANY order → stays uncoded.
  These are valid analyte LOINCs from the export; they differ from the historical 2089-1 the
  target chose for the 2018 LDL (`find-concept --grep '2089-1'` = 0 tables — that exact code is
  genuinely absent), so we emit the real cross-order code instead of fabricating the target's.
- **Component code `.768282` — RECOVERED (code-only).** Target `code.coding[]` carries
  `urn:oid:1.2.840.114350.1.13.283.2.7.2.768282` whose CODE equals `ORDER_RESULTS.COMPONENT_ID`
  (e.g. Glucose .768282 code 1510655 = COMPONENT_ID 1510655). The system is a fixed Epic OID
  and the code is in the export, so we emit `{system:.768282, code:COMPONENT_ID}` on all 46
  components. The clean mixed-case display ("Glucose") is absent — only the UPPERCASE label
  ships (`ORDER_RESULTS.COMPONENT_ID_NAME` and `CLARITY_COMPONENT.NAME`, both UPPERCASE), so
  code-only. The `text` carries `COMPONENT_ID_NAME`.
- **Component Epic alt-codes `urn:oid:...737384.*` — CONFIRMED ABSENT.** No source table ships
  these per-component mnemonics; `find-concept` over the raw TSVs yields none. Not emitted.
- **One-sided / operator / qualitative reference-range *text* — REPRODUCED.** The seven
  text-only ranges in the target (eGFR `>60` on orders 1165205280 & 772179262, Hep C Ab `NR`
  on 945468372, HDL `>40` / LDL `<100` / VLDL `<30` on 1165205279 lines 3/4/5, and H. pylori
  `NEGATIVE FOR H PYLORI STOOL ANTIGEN` on 439060607 line 1) ship verbatim in
  `ORDER_RESULTS.REF_NORMAL_VALS` (with `REFERENCE_LOW/HIGH` and `RAW_REF_VALS` all null on
  those rows). Emitted as `referenceRange[].text` from `REF_NORMAL_VALS`, matching the target
  strings exactly. No overlap risk: 0 rows carry both `REF_NORMAL_VALS` and a numeric bound,
  so two-sided ranges (reconstructed `text` like "0.67 - 1.17 mg/dL") are unaffected. This
  brings lab Observations with `referenceRange` to 44/44.

## Notes on faithfully-reproduced fields (not gaps)

- `effectiveDateTime` = `ORDER_PROC_6.PRIORITIZED_INST_UTC_DTTM` (specimen-collected, UTC) —
  exact match on all reports/specimens/observations.
- `issued` = `ORDER_PROC_6.LAST_FINAL_UTC_DTTM` (falling back to `FIRST_FINAL_UTC_DTTM`, then
  `RSLT_UPD_UTC_DTTM`), the result-finalized instant (UTC). `RSLT_UPD_UTC_DTTM` is the result
  *correction* time, which sits 10 days after the FINAL instant on order 439060607, so it is
  intentionally last in the priority. On the other 8 orders FIRST_FINAL == LAST_FINAL ==
  RSLT_UPD, and all FINAL columns are populated (no null-fallback risk). Matches the target on
  all 9 orders.
- Specimen `receivedTime`/`collectedDateTime`, collector display, accession identifiers,
  encounter CSN, performer (authorizing provider + resulting-lab organization), DR placer/
  filler identifiers, and category codings all reproduce exactly.
