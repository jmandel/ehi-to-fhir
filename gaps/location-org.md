# location-org domain — gaps

Generator: `src/location-org.ts` → `out/Location.json`, `out/Organization.json`
Targets: `fhir-target/Location.json` (6), `fhir-target/Organization.json` (5)
Generated: Location 6, Organization 4.

## Source mapping (what we DID reconstruct)

### Location (target 6)
The target's Locations are the patient-facing *departments* (CLARITY_DEP) the patient was
seen in, plus one service-area "place" (CLARITY_SA id 10, "UnityPoint Health").
- name ← `CLARITY_DEP.EXTERNAL_NAME` (patient-facing), coalesced to `DEPARTMENT_NAME`
  (providers guide Gotcha 8). Selected by the departments of the **emitted** FHIR
  Encounters — i.e. the same encounter-emission predicate `encounter.ts` uses (CSN set),
  not every `PAT_ENC.DEPARTMENT_ID` — excluding the external sentinel dept `8` (§44).
  This yields exactly the 5 clinical departments referenced by emitted Encounters; the
  service-area place makes 6 (matching the target). Departments touched only by
  non-emitted contacts (BUSINESS SERVICES, Central Scheduling) are correctly excluded.
- "UnityPoint Health" ← `CLARITY_SA.EXTERNAL_NAME` of the **unique** `CLARITY_SA` row
  carrying a non-null `EXTERNAL_NAME` (derives to `SERV_AREA_ID = 10`); selected by that
  property, not by a baked-in record id.
- `mode = "instance"` is a constant (FHIR), not from EHI.
- ids minted `id.location(DEPARTMENT_ID)` / `id.location("LOC-10")`.

### Organization (target 5, reconstructed 4)
- "Mac Associated Physicians LLP" (facility): name + Epic service-area id from the
  `CLARITY_SA` row whose `SERV_AREA_NAME` contains the patient's primary-location
  `EXTERNAL_NAME` (derives to SERV_AREA_ID 18 via a name-join, not a hardcoded id);
  NPI / taxonomy / tax-id / address from the 837
  claim-image billing-provider block `CLM_VALUES.BIL_PROV_*`. The match key into
  `CLM_VALUES.BIL_PROV_NAM_LAST` is **derived at runtime**, not hardcoded: it is the
  `EXTERNAL_NAME` of the patient's own primary location
  (`PAT_PRIM_LOC` → `CLARITY_LOC_2`, LOC 1700801 → "ASSOCIATED PHYSICIANS LLP").
- Two lab orgs ("UPH MADISON MERITER SUNQUEST LAB" = LLB 359, "UPH MAC ASSOCIATED
  PHYSICIANS " = LLB 1700801005): name from `CLARITY_LLB`, selected as the result labs
  (`ORDER_PROC.RESULT_LAB_ID`) of laboratory orders (`ORDER_TYPE_C_NAME` Lab/Microbiology).
  - **`Organization.address` for each lab — RECOVERED** (was a documented gap; now
    populated). `CLARITY_LLB` carries no address, but the lab's own orders' result metadata
    does. `buildLabAddress(labId, llbName)` derives it:
    - structured `city`/`state`/`postalCode` ← `PERFORMING_ORG_INFO.PERFORMING_ORG_CITY /
      _STATE_C_NAME / _ZIP_CODE` for that lab's orders;
    - street `line` ← the `ORDER_RES_COMMENT.RESULTS_CMT` narrative
      `"Testing performed at <org>, <street> <city>, <ST> <zip>"`, cut at the structured
      city string (no heuristic street/city split).
    - **Disambiguation (anti-cheat):** `RESULT_LAB_ID 359` alone is ambiguous — its orders'
      performing org is sometimes "Meriter Laboratories" (36 S Brooks St, ZIP 53715-1304)
      and sometimes "Associated Physicians LLP" (4410 Regent St, 53705). We pick the row
      whose `PERFORMING_ORG_NAME` shares a distinctive token with the LLB name
      (MERITER↔Meriter, ASSOCIATED↔Associated; generic tokens UPH/MADISON/LAB/SUNQUEST/MAC/
      LLP/PHYSICIANS excluded), so LLB 359 → "36 S Brooks St, Madison" and LLB 1700801005 →
      "4410 Regent Street, Madison". Emitted verbatim from the EHI (state "Wisconsin", street
      "St" abbreviation); the target's display formatting ("Street", state "WI", no ZIP) is
      Epic presentation, not a data gap.
- "Blue Cross of Wisconsin" (payer): `CLARITY_EPM.PAYOR_ID 1302`; id minted
  `id.organization(1302)` so the Coverage domain's payor ref resolves.

## DATA GAPS (the datum itself is absent from the export)

Every absence below is recorded with the exact whole-export search that proves it, so the
claim is falsifiable (re-run the command to re-confirm). Search gate:
`bun tools/find-concept.ts "<term>" [--grep '<regex>']` scans every `raw/EHITables/*.tsv`
column name, description, and (with `--grep`) value.

- **Organization "UPH MADISON SUNQUEST LAB" (target #3, the distinct historical sender,
  period end 2018) — NOT in the export, so the 5th Organization is not emitted.**
  - `bun tools/find-concept.ts "SUNQUEST" --grep 'MADISON[ ]*SUNQUEST'` → no row anywhere
    matches "MADISON SUNQUEST" **without** "MERITER".
  - `bun lib/q.ts "SELECT RESULTING_LAB_ID,LLB_NAME FROM CLARITY_LLB WHERE LLB_NAME LIKE
    '%SUNQUEST%'"` → only id 359 `UPH MADISON MERITER SUNQUEST LAB` (the MERITER variant we
    DO emit). The distinct non-MERITER sender org lives only in Epic lab-interface sender
    config, which the EHI does not ship.
- **`Organization.alias` (MHMLAB, APLLAB)** — Epic lab-interface mnemonics, not in EHI.
  - `bun tools/find-concept.ts "alias"` → the only populated alias table is `PATIENT_ALIAS`
    (patient soundex aliases); there is no org-alias column on `CLARITY_LLB`
    (only `RESULTING_LAB_ID`,`LLB_NAME`) or `CLARITY_SA` (only id/name/`EXTERNAL_NAME`).
  - `bun tools/find-concept.ts --grep 'MHMLAB|APLLAB'` → 0 tables contain either string.
- **`Organization.telecom`** (the SUNQUEST lab phone `608-417-6529`, system=phone, use=work)
  — not in EHI for any org here.
  - `bun tools/find-concept.ts --grep '417.?6529|6084176529'` → 0 tables.
  - `bun tools/find-concept.ts "phone"` → the only org-adjacent phones are
    `CLM_VALUES_3.SVC_FAC_CNCT_PH = '608-233-9746'` (a DIFFERENT org's service-facility) and
    `PERFORMING_ORG_INFO.PERFORMING_ORG_PHONE_NUM` (1 non-null row, `+1-844-870-8870` for
    Exact Sciences — `PERFORMING_ORG_PHONE_NUM` is **null** for both labs we emit, so even
    the structured performing-org phone is absent for these orgs). Target value genuinely
    absent.
- **`Organization.address.period` / `address.use`-period / `identifier.period` / telecom
  `period`** (Epic effective dates e.g. `2008-01-01`, `2020-12-29T19:43:44Z`,
  `2015-07-30T13:12:04Z`) — Epic master-file metadata, not shipped with the values.
  - `bun tools/find-concept.ts --grep '2008-01-01'` and `... --grep '2020-12-29'` → 0 tables.
  - `bun tools/find-concept.ts "effective"` → 40 populated columns, all clinical/encounter/
    billing effective dates (`PAT_ENC.EFFECTIVE_DATE_DT`, `HSP_TRANSACTIONS_3.TAX_EFFECTIVE_DATE`,
    …); none is an identifier/address/telecom effective date for an org. `CLM_VALUES.BIL_PROV_*`
    and `CLARITY_SA` carry no `period`/`use` companion columns. (The `address.use="work"` we
    DO emit on the lab orgs is derived from the work-context of the performing-org result
    metadata, not from a shipped use code.)
## CODING GAPS (a value/system was lost but the underlying datum is preserved)

- **`Organization.identifier` Epic-instance OID systems.** The target carries several
  identifier *values* under Epic-instance-specific master OIDs that are **not** present in
  the EHI export, so we do not fabricate those OID namespaces. The underlying *values* ARE
  preserved, asserted under their well-known standard systems wherever one exists:
  - NPI `1861412785` → standard `http://hl7.org/fhir/sid/us-npi` (target also under
    Epic OID `...2.7.5.737384.61` — that namespace is the coding gap).
  - tax-id `391837462` → standard EIN OID `urn:oid:2.16.840.1.113883.4.4`.
  - provider taxonomy `193200000X` (from `CLM_VALUES.BIL_PROV_TAXONOMY`) → standard NUCC
    Health Care Provider Taxonomy OID `urn:oid:2.16.840.1.113883.6.101` (the
    FHIR-recommended system). The target's Epic-instance OID `...2.7.5.737384.73` for this
    same value remains the coding gap.
  - service-area id `18` (target under Epic OID `...2.7.2.696570`) is dropped: it is a pure
    Epic-instance master id with no standard system to assert it under.
  - Proof the Epic-instance OID namespaces are absent (so we cannot reproduce them):
    `bun tools/find-concept.ts --grep '737384|696570'` → 0 tables contain either Epic OID
    fragment. The id VALUES are present and preserved; only the Epic OID system labels are
    the coding gap.
- **Name / address casing.** Source values are upper-cased in the EHI
  ("MAC ASSOCIATED PHYSICIANS LLP", "4410 REGENT ST", state "WI"); the target displays
  title/long case ("Mac Associated Physicians LLP", "4410 Regent St", "Wisconsin"). This
  is Epic display-formatting; we emit the EHI value verbatim rather than invent casing.
  (Same characters, different case — not a data gap; path-level shape matches.)

## SELECTION ANCHORS — record-id literals (RESOLVED: now derived, not hardcoded)

- The two service-area selectors that formerly used hardcoded record ids
  (`SERV_AREA_ID = '18'` for the facility org, `SERV_AREA_ID = '10'` for the service-area
  "place" Location) are now DERIVED from the patient's own data. Both resolve to the
  identical ids (`18`, `10`), so the cross-domain reference contract with `patient.ts`
  (`id.organization('18')`) and `encounter.ts` still holds.
  - **SA-18** ← the unique `CLARITY_SA` row whose `SERV_AREA_NAME` contains the patient's
    primary-location `EXTERNAL_NAME` ("ASSOCIATED PHYSICIANS LLP"). Name-join in
    `buildOrganizations`:
    `SELECT sa.SERV_AREA_ID FROM CLARITY_SA sa JOIN CLARITY_LOC_2 l2 ON sa.SERV_AREA_NAME
       LIKE '%'||l2.EXTERNAL_NAME||'%' JOIN PAT_PRIM_LOC ppl ON ppl.LOC_ID=l2.LOC_ID
     WHERE ppl.PAT_ID=? AND ppl.TERM_DATE IS NULL` → exactly one row (18).
  - **SA-10** ← the unique `CLARITY_SA` row with a non-null `EXTERNAL_NAME`
    (`SELECT ... FROM CLARITY_SA WHERE EXTERNAL_NAME IS NOT NULL` → exactly one row, 10).
- `SENTINEL_DEPT_NAME = "GENERIC EXTERNAL DATA DEPARTMENT"` is an **exclusion filter**
  (mapping logic) that drops Epic's well-known external-data sentinel department (§44) — it
  removes a non-real entity from the output rather than copying any target value.

## NOT GAPS — confirmed correct

- `mode`, `active`, `resourceType` — constants/derivable; all at 100%.
- All 4 Location target paths (id, mode, name, resourceType) match at 100%.
- No fabricated (`>> EXTRA`) paths emitted on either type.
- Lab-org `address` (both LLB orgs) now populated from `PERFORMING_ORG_INFO` (structured
  city/state/zip) + `ORDER_RES_COMMENT` narrative (street line), disambiguated by
  performing-org-name↔LLB-name token match — not fabricated, no heuristic street/city split.
