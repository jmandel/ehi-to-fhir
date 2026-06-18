# Practitioner — reconstruction gaps

Source: `CLARITY_SER` (provider master: `PROV_ID`, `PROV_NAME`, `EXTERNAL_NAME` only —
no NPI / specialty / credential / status / gender column ships in this export).
Best-effort cross-master enrichment: `CLARITY_EMP` (`USER_ID`, `NAME`).

## Count / selection
- **Generated 30 vs target 29.** The target is Epic's FHIR-server "providers released
  with this patient's data" set: **22 distinct `CLARITY_SER` providers**, of which **7 are
  emitted twice** (once with NPI/EPIC/Epic ids, once without) → 29 resource rows. That
  duplication is a FHIR-server artifact (two source feeds yielding two opaque ids for one
  provider) and is **not reproducible** — we mint exactly one Practitioner per `PROV_ID`
  via `id.practitioner(PROV_ID)`.
- Our deterministic set = providers **referenced in any care context** that resolve in
  `CLARITY_SER`, minus pure routing/lab sentinels (`199995`, `3724611`, `E1011`); `8800099`
  GENERIC EXTERNAL DATA PROVIDER is kept (the target includes it). This yields 30 distinct
  providers — a superset of 21 of the target's 22, plus 8 providers referenced in this
  patient's orders/notes that Epic's export chose not to release as standalone Practitioners.
  Erring toward the superset keeps cross-resource references (Encounter, CareTeam,
  MedicationRequest, …) from dangling.
- **`554340` (Megan F / login `MSF400`) is in the target but absent from our set** — it is
  referenced by **no** `*_PROV_ID` column anywhere in the export (its only EHI presence is the
  EMP user `MSF400`); the target attaches it through a released-document/user linkage we
  cannot reconstruct deterministically. (data gap — selection)

## Identifier systems we CAN fill (from EHI)
- `…2.836982` SER provider id (INTERNAL width-8 padded + EXTERNAL) ← `PROV_ID`.
- `…737384.99` `CCPROVID` ← `PROV_ID`.
- `…2.697780` EMP login (INTERNAL padded + EXTERNAL) and `…737384.553` (login, no type) ←
  **best-effort** exact, unambiguous name join `CLARITY_SER.PROV_NAME → CLARITY_EMP.NAME`
  (single match only). Resolved on 26/30. **Caveat (ambiguous-join):** SER and EMP are
  separate ID spaces that do not join by id (providers guide, Gotcha 1); we bridge by exact
  display-name string. Two of the target's providers (`137975` Shore, `805364` Gillespie)
  have **no matching `CLARITY_EMP.NAME` row at all** and so get **no** EMP login here — honest
  false-absence rather than a guessed link.
  - **Searched (proves absence):** `CLARITY_EMP` has only `USER_ID` + `NAME`
    (`SELECT * FROM CLARITY_EMP LIMIT 1`). `SELECT … WHERE UPPER(NAME) LIKE '%SHORE%' OR
    '%GILLESPIE%' OR NAME LIKE '%Matthew%' OR '%Benjamin%'` returns `[]` — no EMP row exists
    for these two providers, so the name-join login is genuinely unrecoverable.

## Identifier systems we PARTIALLY fill (from claim rows)
- `http://hl7.org/fhir/sid/us-npi` and `…737384.557` (NPI) — **partially reachable (5/8)**.
  `CLARITY_SER` has no NPI column, but `CLM_VALUES_2` carries the provider's NPI alongside a
  denormalized name (`*_PROV_NAM_LAST/FIRST/MID`) for several billing roles (rendering,
  attending, referring, …). We bridge by an **exact, unambiguous** name join
  `CLM_VALUES_2.{LAST, FIRST} → CLARITY_SER.PROV_NAME` ("LAST, FIRST MID"), accepting only when
  it resolves to a single `PROV_ID`, and require the NPI to be consistent across all claim rows
  for that provider. Resolves cleanly for **Rammelkamp 144590 (1205323193), Dhillon 802011
  (1073855474), Everton 133057 (1790854107), Picone 219711 (1730357849), Gillespie 805364
  (1841421872)** — every value matches the target exactly. (`SVC_LN_INFO.LN_REND_NPI` =
  1205323193 cross-checks Rammelkamp.)
  - **Still a gap (3/8):** **Shore 137975 (1669814737), Cahill 132946 (1891752184), and 599471
    (1073140950)** — these providers were never billed on this patient's claims, so their NPI is
    unreachable in this export.
    - **Searched (proves absence):** a whole-export VALUE scan
      `bun tools/find-concept.ts --grep '1669814737'` (and `1891752184`, `1073140950`) returns
      **0 tables** across `raw/EHITables/*.tsv` for each — the NPI value appears nowhere in the
      export, not merely nowhere in `CLM_VALUES_2`. `SVC_LN_INFO.LN_REND_NPI` distinct = only
      `1205323193` (Rammelkamp); the free-text `ORDER_MED_*` NPI columns
      (`TXT_AUTHPROV_NPI`/`TXT_ORDPROV_NPI`) are empty.
- `…737384.126` (NUCC taxonomy / specialty code) — **partially reachable (5/8)**. `CLARITY_SER`
  has no specialty column, but `CLM_VALUES_2` carries `*_PROV_TAXONOMY` (NUCC codes) next to the
  same provider name. Recovered via the same name-join for the same 5 billed providers:
  **Rammelkamp/Dhillon/Everton 207R00000X, Picone 363LF0000X, Gillespie 208100000X**
  (Gillespie's from `ATT_PROV_TAXONOMY`) — all match the target.
  - **Still a gap (3/8):** Shore's `2085R0202X`/`2085P0229X`, Cahill's `208000000X`, and
    599471's `225X00000X` — these providers carry no claim row in this export, and the
    per-context specialty fields (`PAT_PCP.SPECIALTY_C_NAME`, `TREATMENT_TEAM.TR_TEAM_SPEC_C_NAME`,
    `REFERRAL.PROV_SPEC_C_NAME`) are Epic category names, never NUCC codes — so unreachable.
    - **Searched (proves absence):** a whole-export VALUE scan
      `bun tools/find-concept.ts --grep '2085R0202X'` (and `208000000X`, `225X00000X`) returns
      **0 tables** across `raw/EHITables/*.tsv` — each NUCC code appears nowhere in the export.
      All taxonomy-bearing columns (`SVC_LN_INFO* LN_*_TAXONOMY`, `CLM_VALUES/_2..5 *_PROV_TAXONOMY`)
      carry only the 5 billed providers.

## Identifier systems we CANNOT fill (not in export / Epic- or external-assigned)
- `…737384.60` (EPIC) / `…737384.63` (Epic) — **data gap**: Epic-internal cross-instance
  provider ids, FHIR-server-assigned, not exported.
  - **Searched (proves absence):** `bun tools/find-concept.ts "provider identifier"` surfaces
    only NPI columns (`SVC_LN_INFO*`, `CLM_VALUES*`) and `CLARITY_SER.PROV_ID`. No opaque
    cross-instance provider-id column exists in any table. `CLARITY_SER` has exactly three
    columns (`SELECT * FROM CLARITY_SER LIMIT 1` → `PROV_ID`, `PROV_NAME`, `EXTERNAL_NAME`);
    no `SER_RPT_GRP` / `CLARITY_SER_2` table ships (`SELECT * FROM SER_RPT_GRP` / `CLARITY_SER_2`
    → "no such table").
- `…737384.556` (EXTPROVID) — **data gap**: external-provider opaque id, not exported.
  - **Searched (proves absence):** schema scan for `'%EXT%PROV%ID%'` and
    `bun tools/find-concept.ts "external provider"` return only `REFERRAL_APT.EXT_SVC_PROV_ID`
    (= `147388`, which has a paired `EXT_SVC_PROV_ID_PROV_NAME` join — i.e. an internal
    SER-style provider reference, NOT an external opaque value) and `ORDER_MED_4` `EXT_YN`
    boolean flags. No external-system opaque EXTPROVID value is present.

## Other element gaps
- **`active`** (100% of target) — **data gap**: no provider-level active/inactive datum anywhere.
  - **Searched (proves absence):** `bun tools/find-concept.ts "active"` and `"status"`
    return only patient/order/med/note/account flags. A cross-domain schema scan for columns
    whose name matches `%PROV%` AND (`%ACTIVE%` OR `%STATUS%`) yields only
    `ORDER_PROC_3.PROV_STATUS_C_NAME` (order state: 'Ordered'/'Reviewed'/'Open', not provider
    active flag) and `REFERRAL_HIST.NEW_FIN_PROV_STATUS_C_NAME` (referral-provision status).
    `CLARITY_SER` carries no status column. Omitted rather than guessed.
- **`gender`** (34% of target) — **data gap**: no provider gender/sex column exists.
  - **Searched (proves absence):** `bun tools/find-concept.ts "gender"` / `"sex"` hits are all
    patient/guarantor/family/subscriber (`CLM_VALUES.PAT_SEX`, `PATIENT_4.GENDER_IDENTITY_C_NAME`,
    `ACCOUNT.SEX`, …). The one provider-mentioning hit, `SOCIAL_HX.SEX_SRC_C_NAME`, has value
    'Provider' meaning the *source* of the patient's social-history sex datum was the provider —
    NOT a provider gender. Schema scan for `%PROV%` AND (`%SEX%` OR `%GENDER%`) returns `[]`.
- **`name[].prefix`** ("Dr.", 34% of target) — **data gap**: no "Dr." name-prefix datum exists.
  - **Searched (proves absence):** `bun tools/find-concept.ts "prefix"` returns only patient
    last-name-prefix / family-member / Rx-fill columns, none provider-name-related;
    `"credential"` returns no populated column. The only provider title datum is the
    **per-encounter** rendered credential `PAT_ENC.VISIT_PROV_TITLE_NAME` (DISTINCT values
    'MD'/'DO'/'DNP'/'OT'/'ARRT', keyed by `VISIT_PROV_ID` — i.e. a visit attribute, not a
    stable Practitioner property) and `CLM_VALUES_2.REND_PROV_NAM_SUF` = 'MD' (a name **suffix**
    on one billing row). Both are clinical credentials, the wrong shape for `name.prefix`
    ("Dr."), and neither is a stable per-provider datum — so the target's 'Dr.' prefix is
    unreachable. Not reconstructed.
- **Display-name scrambling** — the target de-identifies names ("Dr. Z Rammelkamp", family
  "Rammelkamp", given "Z"; or "Mary S", family "S", given "Mary"). We emit the **real** name
  from `PROV_NAME`/`EXTERNAL_NAME` ("Zoe L Rammelkamp"). This is a coding/format difference,
  not a data gap — family/given/text shapes all match (`name[].given` 97% vs 100%: the
  external-data sentinel `8800099` has no comma in `PROV_NAME`, so no given name is derivable).
