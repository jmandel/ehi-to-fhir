# Encounter — reconstruction gaps

Source: `PAT_ENC` (+ `_2.._8`, `PAT_ENC_APPT`, `PAT_ENC_HSP`, `PAT_ENC_DISP`,
`PAT_ENC_RSN_VISIT`, `HSP_ADMIT_DIAG`/`CLARITY_EDG`, `PAT_CANCEL_PROC`/`CLARITY_PRC`,
`HNO_INFO`, `ARPB_TRANSACTIONS`/`CLARITY_EAP`, `CLARITY_SER`, `CLARITY_DEP`,
`CL_RSN_FOR_VISIT`, `HSP_ACCOUNT`). Target: 34 Encounters; generated 35.

## Count / selection gap (data gap, irreducible)
- **Target = 34, generated = 35.** The Epic FHIR API exposes a *curated* subset of the
  169 `PAT_ENC` contacts, and that selection is not deterministically reproducible from
  the EHI tables. Evidence: among `CALCULATED_ENC_STAT_C_NAME='Complete'` contacts,
  every contact with an appointment status / `PAT_ENC_HSP` row / `PAT_ENC_DISP` row is
  in the target (0 false positives), but the target *also* keeps two zero-content
  contacts (`829995922` "Orders Only", `1103991540` "Scanned Document") that carry no
  note/reason/status, while *omitting* ~13 real telephone encounters that DO carry a
  clinical note. No EHI column distinguishes the kept from the omitted telephone
  contacts. Our rule (appt-status | HSP | DISP | (note & reason)) yields 35: it captures
  31 of the 34, adds 4 real-but-omitted telephone encounters, and misses 3 zero/low-
  content contacts (`829995922`, `1103991540`, `1169865957`) the API kept. The residual
  delta is Epic-API curation, not a join we missed.

## `class` — DERIVED (FHIR-required, standard v3-ActCode) — fixed
FHIR R4 makes `Encounter.class` a **required (1..1)** `Coding` bound to the **standard**
HL7 v3-ActCode "ActEncounterCode" value set (`http://terminology.hl7.org/CodeSystem/v3-ActCode`:
`AMB`=ambulatory, `IMP`=inpatient, `EMER`=emergency, `OBSENC`=observation, `VR`=virtual…).
Because this value set is a standard code system (not Epic terminology), it **is** derivable
and we now emit it (`buildClass()` in `src/encounter.ts`), fixing 35 validator errors
("Encounter.class: minimum required = 1, but only found 0" — 35 before → 0 after).

- **Derivation source:** `ADT_PAT_CLASS_C_NAME` — the Epic ADT patient-class label, read
  from `PAT_ENC_HSP` for facility/ADT contacts and otherwise from `PAT_ENC_2`. Mapped to
  v3-ActCode via a small deterministic enum map (Inpatient→IMP, Emergency→EMER,
  Observation→OBSENC, Outpatient / "Therapies Series"→AMB). No per-CSN hardcoding.
- **Distribution produced: AMB × 35 (all).** The *only* non-blank patient class anywhere
  in this export is "Therapies Series" (the 2 outpatient hospital-therapy / HOV contacts,
  CSNs 922942674 / 922943112). That is ambulatory care — there is no admission anywhere
  (`ADT_PAT_CLASS_C_NAME` is never Inpatient/Emergency; `HOSP_ADMSN_TYPE_C_NAME` is at most
  "Elective"), so those 2 map to AMB, as does every appointment / lab / telephone /
  support-OP contact.
- **Fallback note:** the 33 contacts with a blank `ADT_PAT_CLASS_C_NAME` (every
  appointment, lab, telephone, and support-OP encounter) hit the map's default → AMB.
  This is a *defensible* default, not a guess: all selected contacts are ambulatory
  office/lab/telephone/outpatient-therapy visits with no admission, and Epic's own
  proprietary class for them is "Appointment"/"Support OP Encounter" (both ambulatory).
- **`VR` (virtual) — class stays AMB; telehealth signal moved to `type`.** The target does
  NOT classify its two telehealth contacts (CSNs 1127808563, 829213099) as v3-ActCode `VR`:
  the target `Encounter.class` is the Epic PROPRIETARY class code (`.696784.13260`)
  "Appointment", which (not being reproduced) maps to our standard AMB. So there is no `VR`
  class gap. The telehealth datum is carried in `Encounter.type` instead, and IS now partly
  derived (see the `type` section): CSN 829213099 → "Telehealth" (`CLARITY_PRC.EXTERNAL_NAME`
  via `PAT_CANCEL_PROC`); CSN 1127808563 has a real video-visit signal
  (`PATIENT_ENC_VIDEO_VISIT.PAT_ENC_LVL_VIDEO_VISIT_ID=390423`) but no matching label
  string to emit. The earlier claim that telehealth is "unrecoverable" because the
  `EVISIT_*` flags are blank was overstated — blank flags do not mean the datum is absent;
  the per-encounter video-visit row and the `CLARITY_PRC` visit-type label both exist.
- **Epic's proprietary `class` triple (system `…696784.13260`, codes 4/5/13 =
  "HOV"/"Appointment"/"Support OP Encounter") is NOT reproduced** — that proprietary
  label/code is absent from the export (no `ENC_TYPE_C`; the only type-named columns,
  `PAT_ENC_6.HUS_VISIT_TYPE_C_NAME` / `PAT_ENC_BILLING_ENC.BILLING_ENC_TYPE_C_NAME`, are
  100% NULL). We emit the standard v3-ActCode that FHIR actually requires instead.

## `type` — PARTIALLY RECOVERED (text-only) + documented residual gaps

`Encounter.type` was previously **omitted entirely** with the assertion "the CPT is
stripped on export — no CPT/HCPCS column anywhere." That assertion was **false** (CPT codes
do exist, see below). `type[]` is now emitted as **text only** (the Epic numeric codes +
OID systems `…698084.30` / `…2.808267` / `…698084.18875` / `…698084.10110` are genuinely
not in the export, so no `coding` is fabricated — principle 3).

**RECOVERED (label faithfully in the export — emitted as `type[].text`):**
- **"Elective" acuity ← `PAT_ENC.HOSP_ADMSN_TYPE_C_NAME`.** Exact per-encounter source.
  `SELECT HOSP_ADMSN_TYPE_C_NAME, COUNT(*) FROM PAT_ENC GROUP BY 1` → Elective ×24, NULL
  ×145. Cross-checked against the target: **all 19** target encounters carrying the
  `.18875`/"Elective" type have `HOSP_ADMSN_TYPE_C_NAME='Elective'`, and every Elective
  `PAT_ENC` row that is *in* the curated 34 carries the target type — 19/19, zero
  false-pos/false-neg. (The 5 other Elective `PAT_ENC` rows — 1183640405, 829212157,
  921952141, 948002801, 958148226 — are simply not in the target's 34.) Telephone CSNs
  (1175103496, 837844366) are NULL, mirroring the target (no Elective there).
- **Telehealth visit type ← `CLARITY_PRC.EXTERNAL_NAME` via `PAT_CANCEL_PROC.CAN_PRCD_C_ID`.**
  For CSN 829213099 the per-encounter visit-type procedure `570827036` resolves to
  `CLARITY_PRC.EXTERNAL_NAME='Telehealth'` — the **exact** target type display
  (`.808267` code 570827036 "Telehealth"). Emitted as `{ text: "Telehealth" }`.

**RESIDUAL GAPS (searched, proven not cleanly emittable):**
- **Visit-type labels "Office Visit"/"Telephone"/"Lab"/"Results Follow-Up"/"Telemedicine"
  (`.698084.30`) — CONFIRMED ABSENT.** Searched `find-concept "visit type"/"encounter
  type"/"type of contact"`. **No `ENC_TYPE_C` column exists anywhere in the `PAT_ENC`
  family.** The two named candidates are 100% NULL:
  `SELECT HUS_VISIT_TYPE_C_NAME, COUNT(*) FROM PAT_ENC_6 GROUP BY 1` → all 169 NULL;
  `SELECT BILLING_ENC_TYPE_C_NAME, COUNT(*) FROM PAT_ENC_BILLING_ENC GROUP BY 1` → all NULL.
- **The other `.808267` visit-type codes (Office Visit 570821122, Lab 570824604, Physical
  Exam 570821002, …) — CONFIRMED ABSENT.** Value-scan `find-concept --grep
  '570821122|570824604|570827036|…'` hits only `CLARITY_PRC` (which holds exactly ONE row,
  570827036 "Telehealth") and `PAT_CANCEL_PROC` (CSN 829213099 only). The bulk are absent
  from every populated CSN-linked table → only the single "Telehealth" code is recoverable.
- **"Virtual Care Visit"/"Telemedicine" for CSN 1127808563 — SIGNAL present, LABEL absent.**
  A real telehealth signal exists (`PATIENT_ENC_VIDEO_VISIT.PAT_ENC_LVL_VIDEO_VISIT_ID=390423`
  populated only for this CSN; ARPB charge "SYNCHRONOUS AUDIO-VIDEO VISIT"), but **no
  matching label string** ("Virtual Care Visit"/"Telemedicine") is in the export
  (`TH_MODE_VV_*` columns are NULL for this row). Emitting the target text would fabricate
  a label, so it is omitted (the boolean video-visit fact is real but has no FHIR-`type`
  representation without inventing the display).
- **CPT-coded level-of-service line (99213/99396/99214/99395 …) — LOSSY PROXY, not emitted.**
  CORRECTION to the prior false claim: **real CPT codes DO exist** in the export —
  `SELECT LN_PROC_CD, LN_PROC_QUAL, LN_FROM_DT FROM SVC_LN_INFO WHERE LN_PROC_QUAL='HC'`
  returns 99213@1/9/2020, 99396@11/7/2024, 99214@12/1/2022, 99395@8/9/2018, … (also
  `INV_CLM_LN_ADDL.UB_CPT_CODE`, `HSP_TX_LINE_INFO.LL_CPT_CODE`). But it is a claim
  service-line proxy, not the encounter's coded type, and cannot be cleanly attached:
  - **No CSN key.** `SVC_LN_INFO.RECORD_ID` is the *claim* id; `PAT_ENC.CLAIM_ID` is 100%
    NULL (`SELECT PAT_ENC_CSN_ID, CLAIM_ID FROM PAT_ENC` → CLAIM_ID NULL for all selected
    CSNs), and `SVC_LN_INFO` carries only a service DATE, so the only link to a CSN is
    same-date.
  - **Over-emits non-type lines.** Same-date claim lines include labs (80048/83036/36415),
    vaccines (90471/96431), and add-ons (G2211 / "COMPLEX E/M VISIT ADD ON") that the
    target never lists as a `type`. (Verified via `ARPB_TRANSACTIONS` joined to
    `CLARITY_EAP.PROC_NAME`: 8 office CSNs carry 2-4 distinct charge PROCs each.)
  - **Diverges from the target's coded LOS** on real encounters: CSN 958148810 target=99212
    "SF MDM 10 MIN" but SVC/ARPB=99213 "LOW MDM 20 MIN"; CSN 1127808563 target=99213 but
    SVC=98005/G2211 + ARPB="SYNCHRONOUS AUDIO-VIDEO VISIT".
  - **Display lives elsewhere.** `SVC_LN_INFO.LN_PROC_DESC` is NULL; the target display
    ("PR OFFICE/OUTPATIENT ESTABLISHED LOW MDM 20 MIN") is `CLARITY_EAP.PROC_NAME` reached
    via `ARPB.PROC_ID` — a third table.
  Attaching this per-encounter would inject wrong/extra codes (false-presence), so the CPT
  type line is deliberately NOT emitted — a **lossy-source** gap, not a confirmed-absence.

## Epic-terminology codings absent from the export (coding gaps — code/system lost)
- **`hospitalization.admitSource.coding` (system `…698084.10310`, code 1 "Self" /
  2 "Clinic or Physician").** Searched all admit-source columns (`find-concept "admit
  source"`; `p.name LIKE 'ADMIT_SOURCE%'`/`'ADMISSION_SOURCE%'`): every match is a
  `*_C_NAME` *label* column (PAT_ENC_HSP, HSP_ACCOUNT, HSP_ACCT_CLAIM_HAR, CLAIM_INFO,
  REFERRAL_5); the only documented numeric `_C` candidate (`OR_CASE.ADMIT_SOURCE_C_NAME`)
  is empty/not-shipped. `SELECT ADMIT_SOURCE_C_NAME FROM PAT_ENC_HSP` → 'Self' (both
  facility CSNs); `CLAIM_INFO.ADMISSION_SOURCE_C_NAME` NULL. No numeric Epic category-code
  column for admit source exists → `admitSource.text` only on the 2 facility encounters.
- **`hospitalization.dischargeDisposition.coding` (system `…698084.18888`, code 1).**
  Searched all `DISCH_DISP%`/`DISCHARGE_DISP%` columns: only `*_C_NAME` label columns ship
  populated (`PAT_ENC_HSP`, `HV_ORDER_PROC`); the numeric/code candidates
  (`AP_CLAIM.PAT_STATUS_C_NAME`, `OTP_INFO_2.DISCHRG_DISP_C_NAME`, …) are empty/not-shipped.
  `SELECT DISCH_DISP_C_NAME FROM PAT_ENC_HSP` → 'Home - Discharge to Home or Self Care'.
  No numeric Epic category-code column → `dischargeDisposition.text` only.
- **`reasonCode[].coding` SNOMED (`http://snomed.info/sct`, e.g. 429656004) — code lost,
  concept+display RECOVERED.** The HOV therapy-series reason concept IS in the export — in
  `HSP_ADMIT_DIAG`, a table the prior generator did not check: `SELECT * FROM
  HSP_ADMIT_DIAG WHERE DX_ID='284018'` → CSN 922943112; `SELECT DX_NAME FROM CLARITY_EDG
  WHERE DX_ID='284018'` → "Late effect of traumatic injury to brain" = the EXACT target
  reasonCode display. (The other HOV CSN 922942674 has no target reasonCode, so no gap.)
  We now emit it as `reasonCode[].text`. The SNOMED **code** itself remains unrecoverable:
  `find-concept "snomed"` shows SNOMED columns only on lab/specimen tables (ORDER_RESULTS,
  SPEC_TYPE_SNOMED); there is no DX_ID→SNOMED map (`CLARITY_EDG` has only DX_ID/DX_NAME),
  so we emit text without a fabricated SNOMED coding (consistent with the Condition domain).

## Fields absent from the export (data gaps — datum itself missing)
- **`extension` accidentrelated (`…/accidentrelated`, valueBoolean=FALSE on 18/34) —
  CONFIRMED ABSENT.** Cross-domain search `find-concept "accident"` surfaced
  `APPT_REQUEST.REQ_IS_ACCIDENT_YN`, `CLAIM_INFO.ACCIDENT_TYPE_C_NAME`,
  `PAT_ENC_HSP.ER_INJURY`. None reproduces a per-encounter boolean:
  `SELECT REQ_IS_ACCIDENT_YN, COUNT(*) FROM APPT_REQUEST GROUP BY 1` → all 22 NULL (and
  APPT_REQUEST has no CSN link); `SELECT ER_INJURY, COUNT(*) FROM PAT_ENC_HSP GROUP BY 1`
  → all NULL; no ACCID/INJUR column anywhere in the `PAT_ENC` family is populated.
  `CLAIM_INFO` carries `ACCIDENT_TYPE_C_NAME`/`INJURY_DATETIME` but that is a different
  concept (2 specific injury claims, not a uniform per-encounter false flag on 18 CSNs).
  → omitted entirely.
- **`period.end` for appointments / `participant[].period.end` — CONFIRMED ABSENT.** The
  appointment slot *length* is not exported. `PAT_ENC_APPT` columns are exactly
  `[PAT_ENC_CSN_ID, LINE, CONTACT_DATE, DEPARTMENT_ID, PROV_START_TIME]` — only a start.
  Searched `find-concept "appointment length"/"slot"/"end time"/"visit length"` and the
  `PAT_ENC` family for `END`/`LENGTH`/`DURATION`/`SLOT`/`STOP`/`FINISH`: all candidate
  length/end columns are empty/not-shipped (`VISIT_SET_SLOT.*`,
  `ORDER_APPT_INFO.APPT_EXAM_END_TIME`, `HH_PAT_ENC.VISIT_END_DTTM`,
  `DENTAL_VISIT_INFO.VISIT_APPT_LENGTH`). We emit `period.start` (and the participant
  period start) from `PROV_START_TIME`; the end is unrecoverable. (Facility HOV encounters
  DO get a real end from `HOSP_DISCH_TIME`; support encounters get a date-only start=end
  from `CONTACT_DATE`.)

## Faithfully reconstructed (no gap)
- `identifier` (CSN value + the export's CSN OID system), `status` ("finished" — all
  selected contacts are `CALCULATED_ENC_STAT_C_NAME='Complete'`), `subject`, `location`
  (department reference + `CLARITY_DEP` display; HOV location period from admit/disch),
  `account` (HOV: `HSP_ACCOUNT_ID` + the export's hospital-account OID + name).
- `participant`: REF (`REFERRAL_SOURCE_ID`), losAuthorizingPhysician
  (`PAT_ENC_DISP.LOS_AUTH_PROV_ID`), PART (`VISIT_PROV_ID` + appt-start period) —
  with the v3-ParticipationType codings, which ARE standard (not Epic-internal).
  - **Lab-resource visit provider suppressed for PART.** On the 5 Lab-class contacts
    (CSNs 1028743701, 1169847546, 724628999, 725327197, 958147754) `VISIT_PROV_ID` is the
    non-human laboratory resource `MAC LAB APL` (`CLARITY_SER.PROV_ID=3724611`), not a
    clinician. The curated target emits only the REF participant for these, with no
    Practitioner PART. We therefore skip the PART participant when `VISIT_PROV_ID`'s
    `CLARITY_SER.PROV_NAME` denotes a lab resource (matches `MAC LAB APL` / contains
    ` LAB `), so the participant role sets match the target exactly. (`prac-3724611` is a
    lab pseudo-provider, not a real Practitioner — emitting it would be a fabricated
    clinician participation.)
- `reasonCode`: `PAT_ENC_RSN_VISIT.ENC_REASON_ID` IS the code in the CL_RSN_FOR_VISIT
  OID `…2.728286` (verified: 42=Establish Care, 83=Annual Exam, 632=Transfer Of Care);
  emitted with real system + code, text from `CL_RSN_FOR_VISIT.REASON_VISIT_NAME` (EHI
  uppercase, vs the target's title-cased display — a cosmetic, non-fabricated difference).
  For the HOV therapy-series contacts (no `PAT_ENC_RSN_VISIT` row) the reason is the admit
  diagnosis: `HSP_ADMIT_DIAG.DX_ID` → `CLARITY_EDG.DX_NAME`, emitted as `reasonCode.text`
  (CSN 922943112 → "Late effect of traumatic injury to brain", matching the target text;
  the SNOMED code is absent — see the coding-gaps section).

## Display-value note (not a gap)
Provider/department/practitioner display strings use the raw EHI names
(`CLARITY_SER.PROV_NAME` "RAMMELKAMP, ZOE L", `CLARITY_DEP.DEPARTMENT_NAME`
"MAC APL INTERNAL MEDICINE") rather than the Epic-FHIR-formatted variants in the target
("Dr. Z Rammelkamp", "Assoc Physicians Internal Medicine"). The formatted display is an
Epic API transformation; we keep the source-of-truth label. References are minted via
`lib/ids` so they stay internally consistent across domains.
