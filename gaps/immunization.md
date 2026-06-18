# Immunization — reconstruction gaps

Spine: `IMMUNE` (EPT per-dose ledger), reached via `PAT_IMMUNIZATIONS` (PAT_ID → IMMUNE_ID).
**Counts match exactly: target 19, generated 19**, one Immunization per surviving `IMMUNE`
row, keyed by `IMMUNE_ID`. The 2 orphan `PAT_IMMUNIZATIONS` bridge lines (soft-deleted doses
with no `IMMUNE` row, immunizations guide §"Orphan bridge lines") are correctly excluded — the
target omits them too.

Every "absent" claim below is paired with the **exact search that proves it** (run from
`ehi-fhir/`), so the claim is falsifiable rather than asserted. Re-run any of these to re-verify.

## Coding gaps (text/display preserved, the standardized/coded value is genuinely absent)

- **`vaccineCode.coding` (CVX)** — *CONFIRMED ABSENT.* Target carries
  `{system: http://hl7.org/fhir/sid/cvx, code: "150"}` (in-house dose), `171`, `52`, etc. These
  CVX codes are a **FHIR-layer terminology crosswalk applied outside the export** — they are not
  the Epic immunization IDs the export ships. Proof:
  - `bun tools/find-concept.ts "cvx"` → 0 populated columns; `bun tools/find-concept.ts "vaccine code"` → 0.
  - No column named like CVX anywhere:
    `bun lib/q.ts "SELECT t.name,p.name FROM sqlite_master t JOIN pragma_table_info(t.name) p WHERE p.name LIKE '%CVX%'"` → `[]`.
  - `CLARITY_IMMUNZATN` ships only `IMMUNZATN_ID`+`NAME`
    (`bun lib/q.ts "SELECT name FROM pragma_table_info('CLARITY_IMMUNZATN')"` → `IMMUNZATN_ID, NAME`).
  - The export's `IMMUNZATN_ID` ≠ CVX: in-house dose `IMMUNE_ID 104512005` has `IMMUNZATN_ID 42890686`
    (target CVX `150`); these do not equal each other and no crosswalk table ships.
  - We emit `vaccineCode.text` from `IMMUNZATN_ID_NAME` (verbatim ALL-CAPS; the target's re-cased text
    is also a FHIR-layer enrichment we do not fabricate).
- **`vaccineCode.coding` NDC** — *PRESENT and EMITTED* (the one external standardized vaccine code in
  the export). `IMMUNE.NDC_NUM_ID_NDC_CODE = '58160-909-52'` on `IMMUNE_ID 104512005`
  (`bun lib/q.ts "SELECT NDC_NUM_ID_NDC_CODE FROM IMMUNE WHERE IMMUNE_ID='104512005'"`).
  `src/immunization.ts` emits it as `{system: http://hl7.org/fhir/sid/ndc, code}` — matches target 1/19.
- **`site.coding[].code` / `.system`** (Epic OID `…768076.4040`, bare code e.g. `14`=Left Arm) —
  *CONFIRMED ABSENT.* No bare `_C` code and no `ZC_` table ship (general-patterns §23). Proof:
  - No bare site `_C` column:
    `bun lib/q.ts "SELECT t.name,p.name FROM sqlite_master t JOIN pragma_table_info(t.name) p WHERE p.name IN ('SITE_C','IMM_SITE_C')"` → `[]`.
  - No `ZC_` table: `bun lib/q.ts "SELECT name FROM sqlite_master WHERE name LIKE 'ZC%'"` → `[]`.
  - Only the display ships: `IMMUNE.SITE_C_NAME`, `IMM_ADMIN.IMM_SITE_C_NAME`,
    `IMMUNE_HISTORY.IMMNZTN_HX_SITE_C_NAME`. We emit `site.text` + `coding.display` from the name.
- **`route.coding[].code` / `.system`** (Epic OID `…768076.4030`, bare code `2`=Intramuscular) —
  *CONFIRMED ABSENT.* Same mechanism. Proof: no bare route `_C` column
  (`…p.name IN ('ROUTE_C','IMM_ROUTE_C','MED_ROUTE_C')` → `[]`), no `ZC_` table. Only the displays
  ship (`IMMUNE.ROUTE_C_NAME='Intramuscular'`, `IMM_ADMIN.IMM_ROUTE_C_NAME`, `ORDER_MED.MED_ROUTE_C_NAME`).
  Emitted `route.text` + `coding.display`.
- **`reportOrigin.coding[].code` / `.system`** (Epic OID `…768076.4082`, bare code e.g. `2`=Confirmed) —
  *CONFIRMED ABSENT.* Same mechanism. Proof: no bare `EXTERNAL_ADMIN_C` column
  (`…p.name='EXTERNAL_ADMIN_C'` → `[]`), no `ZC_` table. Only `EXTERNAL_ADMIN_C_NAME`
  ("Confirmed"/"MyChart Entered") ships. Emitted `reportOrigin.text` + `coding.display`. Present where
  `EXTERNAL_ADMIN_C_NAME` is set, matching target.
- **`doseQuantity.system` / `.code`** (Epic OID unit `…768076.4019`, code `"1"`) — *CONFIRMED ABSENT.*
  Amount + unit display ship and ARE emitted (`IMMNZTN_DOSE_AMOUNT`=0.5, `IMMNZTN_DOSE_UNIT_C_NAME`=mL
  → `value`+`unit`); the coded unit is not in the export. Proof: no bare dose-unit `_C` column
  (`…p.name IN ('IMMNZTN_DOSE_UNIT_C','IMM_DOSE_UNIT_C')` → `[]`), no `ZC_` table, no UCUM coding anywhere.

> The display-only `coding` entries above (system-less) produce the validator's
> "Coding has no system" warnings. These are the acceptable offline-terminology warnings: the bare
> Epic code and its OID system are genuinely absent, so the only thing recoverable is the display.

## Data gaps (the datum itself is absent from the export)

- **`encounter.display`** ("Office Visit" / "Abstract") — *CONFIRMED ABSENT.* The encounter
  reference + business identifier (CSN) ARE reproduced from `IMMUNE.IMM_CSN`; the human-facing
  **encounter type label is not in the export**. Proof:
  - No `ENC_TYPE_C_NAME` on any `PAT_ENC*` table; the only `%ENC_TYPE%` column there is the unrelated
    `PAT_ENC_BILLING_ENC.BILLING_ENC_TYPE_C_NAME`
    (`bun lib/q.ts "SELECT t.name,p.name FROM sqlite_master t JOIN pragma_table_info(t.name) p WHERE t.name LIKE 'PAT_ENC%' AND p.name LIKE '%ENC_TYPE%'"`).
  - `bun tools/find-concept.ts "encounter type"` returns only `REFERRAL_2.RFL_ENC_TYPE_C_NAME` and the
    billing column above — neither is the clinical CSN-keyed visit type.
  - The Encounter domain (`src/encounter.ts`) independently omits type for the same reason. The label
    is an Epic FHIR-layer enrichment.
- **`location` / `location.display`** ("UnityPoint Health") — *CONFIRMED NOT DERIVABLE (partial).*
  The literal brand string DOES exist as a masterfile value — `CLARITY_SA.EXTERNAL_NAME='UnityPoint
  Health'` (SERV_AREA_ID 10) and `CLARITY_LOC_2.EXTERNAL_NAME='UnityPoint Health'` (LOC_ID 10) — but
  **there is no data path tying the one in-house dose to that service area**, so emitting it would be
  hardcoding the health-system name, not deriving it. Proof of the broken path (in-house dose
  `IMMUNE 104512005`, `IMM_CSN 991225117`):
  - The encounter has no service-area key: `PAT_ENC` ships only `DEPARTMENT_ID` + `PRIMARY_LOC_ID`
    (no `SERV_AREA_ID` column;
    `bun lib/q.ts "SELECT name FROM pragma_table_info('PAT_ENC') WHERE name LIKE '%SERV%'"` → `[]`).
  - Its department/location resolve to a *different* org, not the brand: `DEPARTMENT_ID 1700801002` →
    `CLARITY_DEP.EXTERNAL_NAME='Assoc Physicians Internal Medicine'`; `PRIMARY_LOC_ID 1700801` →
    `CLARITY_LOC_2.EXTERNAL_NAME='ASSOCIATED PHYSICIANS LLP'`. Neither masterfile carries a
    service-area/parent column to climb to SA 10 (`CLARITY_DEP` cols = `DEPARTMENT_ID, DEPARTMENT_NAME,
    EXTERNAL_NAME`; `CLARITY_LOC_2` cols = `LOC_ID, EXTERNAL_NAME`).
  - The dose has no `IMM_ADMIN` (DXR) row, so no `IMM_LOCATION` either
    (`IMM_ADMIN.IMM_LOCATION` only ever holds retail-pharmacy strings like 'CVS #04930' for external doses).
  - Target shape is a bare `{display:"UnityPoint Health"}` with no reference — the parent-org brand,
    present as a string but not linkable to this datum. Omitted (target has it on 1/19).

## Fields fully reproduced

`identifier` (IMMUNE_ID, system `…768076`), `status` (Given→completed), `patient`,
`occurrenceDateTime` (IMMUNE_DATE), `vaccineCode.text` (IMMUNZATN_ID_NAME) + NDC coding (1/19),
`primarySource` (IMM_HISTORIC_ADM_YN≠'Y'), `reportOrigin.text` (5/19), `manufacturer.display`
(MFG_C_NAME), `lotNumber` (LOT), `expirationDate` (EXPIRATION_DATE), `site.text`/`route.text`,
`doseQuantity` value+unit, `encounter` reference+identifier (CSN, system `…698084.8`, 14/19), and
`performer` (AP = `GIVEN_BY_USER_ID`→CLARITY_EMP for the display, bridged USER_ID→CLARITY_SER.PROV_ID
via the exact, unambiguous `CLARITY_EMP.NAME = CLARITY_SER.PROV_NAME` join for the `actor.reference`
so it lines up with the Practitioner domain's PROV_ID-keyed ids; OP = order's
`AUTHRZING_PROV_ID`→CLARITY_SER, both with v2-0443 function codes) — all on the single in-house dose
(IMMUNE 104512005), matching the target's 1/19 prevalence. If a USER_ID has no single SER name match
the `actor.reference` is omitted (display kept) rather than emitting a dangling `prac-<USER_ID>`.
Provider/user display names are emitted in the export's "LAST, FIRST" form; the target's FHIR-layer
reformatting ("Mary S", "Dr. Z Rammelkamp") is not in the export.
