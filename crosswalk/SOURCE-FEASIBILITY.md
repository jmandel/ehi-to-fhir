# Could Epic actually ship this crosswalk? Where the standard codes really live

We reconstructed `ALL.csv` by pairing EHI local codes with the standard codings in the
*reference FHIR* (the answer key). The real question: **does the source data to BUILD this
table exist in the EHI export / Clarity, or only in Chronicles / an external terminology
service?** Answer: it's a **two-tier** story, and Tier 2 is an *export-scope* decision, not
a "go mine another system" problem.

## What the export actually ships for the master files (VERIFIED here)

Epic's master/dictionary records are shipped **stripped to `ID + NAME`** — the standard-code
columns are dropped:

| Master | Shipped columns (this export) | Standard code present? |
|---|---|---|
| `CLARITY_EDG` (diagnosis) | `DX_ID, DX_NAME, PAT_FRIENDLY_TEXT` | ❌ no ICD / SNOMED |
| `CLARITY_MEDICATION` (med) | `MEDICATION_ID, GENERIC_NAME` | ❌ no RxNorm / NDC / GPI |
| `CLARITY_IMMUNZATN` (vaccine) | `IMMUNZATN_ID, NAME` | ❌ no CVX |
| allergen | (no allergen master shipped at all) | ❌ |

The billing diagnosis rows (`TX_DIAG`, `ARPB_CHG_ENTRY_DX`) only carry `DX_ID` too — they
point at the same stripped master, not at an ICD string.

## Tier 1 — already IN the EHI export (no need to look elsewhere) ✅

Where the standard code is captured on a **transactional** row (the event), not only on the
master, it survived the export:

| Mapping | Source in THIS export (verified) |
|---|---|
| lab component → **LOINC** | `ORDER_RESULTS.COMPON_LNC_ID` (47 rows) + `LNC_DB_MAIN` LOINC dictionary |
| lab/organism/specimen → **SNOMED** | `ORDER_RESULTS.COMP_SNOMED_CT`, `ORGANISM_SNOMED_CT`, `SPEC_TYPE_SNOMED` |
| medication (dispensed/claimed) → **NDC** | `SVC_LN_INFO.LN_NDC` (33), `IMMUNE.NDC_NUM_ID_NDC_CODE` |
| immunization → **NDC** | `IMMUNE_HISTORY.IMM_HX_NDC_NUM_ID_NDC_CODE` (30) |

These crosswalk areas are **self-sufficient** — buildable from the EHI alone, *without* the
FHIR answer key. (The lab/vital crosswalks we generated are therefore real, not circular.)

## Tier 2 — NOT in this export; needs the master-file/terminology columns ❌→ widen the extract

| Mapping | Where it lives in Epic | In the EHI export? |
|---|---|---|
| diagnosis → **ICD-10 / ICD-9** | EDG master (Clarity `EDG_CURRENT_ICD10` / `EDG_CURRENT_ICD9`) | no (only `DX_ID/DX_NAME` shipped) |
| problem → **SNOMED** | EDG / IMO-resolved code persisted on the diagnosis record | no |
| medication (ordered) → **RxNorm** | ERX/med master (RxNorm/GPI on the medication record) | no |
| immunization → **CVX** | immunization master (CVX-coded field) | no |
| allergen → **SNOMED / RxNorm / UNII** | allergen master | no (master not shipped) |

## The bottom line

- **Epic does NOT need to leave Clarity/Chronicles.** Every Tier-2 mapping is a **standard
  Clarity master-file column** that Epic already persists: `EDG_CURRENT_ICD10/ICD9` for
  diagnoses, the medication record's RxNorm/NDC, the immunization record's CVX, the allergen
  record's coded mappings. The relational data exists; this EHI export just **scopes the
  master extracts down to `ID + NAME`.**
- So shipping the crosswalk is an **export-configuration change** (include the code columns
  Clarity already has), **not** a data-availability problem and **not** a reach into
  Chronicles internals or a live terminology-service call.
- Nuance: the *upstream* source of problem ICD/SNOMED is typically Epic's **IMO** terminology
  integration, but IMO's resolved codes are written onto the EDG record and extracted to
  Clarity — i.e. available at rest, no live IMO call required.
- The only mapping with **no relational home anywhere** in Epic-at-rest is **SmartData → SNOMED/
  LOINC**, because the `SMRTDTA_*` element store itself isn't exported (and even in Clarity the
  SDE concept mapping is a separate, often-unextracted layer). That's the one genuinely harder
  case — consistent with it being our only 0%-verified area.

### Evidence basis
Tier-1 rows and the stripped-master columns above are **verified against this export's
schema + data**. The Tier-2 "where it lives in Clarity" column reflects the **standard Epic
Clarity data model** (EDG ICD tables, med-record RxNorm, immunization CVX) from general
knowledge, not from this export (which omits those columns) — flagged as such for honesty.
