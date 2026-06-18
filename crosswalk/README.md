# Terminology bridge — the crosswalk Epic *could* ship to close the coding gap

## The idea

An EHI export ships Epic's **local** codes (`DX_ID`, lab `COMPONENT_ID`, `MEDICATION_ID`,
flowsheet `FLO_MEAS_ID`, `_C_NAME` categoricals, …) but **not** the standard terminologies
(LOINC, SNOMED, RxNorm/NDC, CVX, ICD-10/9, CPT) that Epic's live FHIR API attaches. That
single omission is ~half of all our shape gaps (see `../SHAPE-GAPS.md`).

One extra export artifact would close most of it: a **crosswalk table** mapping each Epic
local code → its standard coding(s). Epic maintains exactly this internally (it's how the
FHIR server populates `code.coding`). This folder **reconstructs an excerpt** of that table
for the concepts that appear in *this* patient's data, by pairing the two things we already
have:

- the **EHI** (Epic local codes), and
- the **reference FHIR** (`../fhir-target/`), whose `code.coding` arrays usually carry the
  Epic-local coding **and** the standard coding *side by side*.

Pair them on the shared Epic-local code and you recover the row. A real export would simply
emit this table directly; a generator then `LEFT JOIN`s it on the local code at translation
time to attach `code.coding` entries it otherwise has to drop.

## File format (RFC-4180 CSV, one row per local-code → standard-code mapping)

One CSV per terminology area in this folder (`lab.csv`, `problem.csv`, `medication.csv`, …)
plus a merged `ALL.csv`. Identical header in every file:

```
area,fhir_path,concept_display,ehi_join_table,ehi_join_column,epic_local_system,epic_local_code,epic_local_display,target_system,target_code,target_display,anchor_method,ehi_verified,confidence,notes
```

| column | meaning |
|---|---|
| `area` | lab \| vital \| problem \| encounter-dx \| medication \| immunization \| allergy \| smartdata \| survey \| social \| document \| coverage \| other |
| `fhir_path` | where the coding sits, e.g. `Observation.code`, `Observation.valueCodeableConcept`, `Condition.code`, `Medication.code`, `Immunization.vaccineCode` |
| `concept_display` | human label for the concept (the `.text` / display) |
| `ehi_join_table` / `ehi_join_column` | **the join point a real export would use** — the EHI table.column holding `epic_local_code` (e.g. `PROBLEM_LIST.DX_ID`, `ORDER_RESULTS.COMPONENT_ID`, `ORDER_MED.MEDICATION_ID`) |
| `epic_local_system` | the Epic-internal OID system the local code lives under (the `urn:oid:1.2.840.114350…` seen in target `code.coding`), or the EHI master-file name |
| `epic_local_code` | the Epic-local code value — the actual key found in the EHI |
| `epic_local_display` | local display/name for that code, if any |
| `target_system` | the standard system to attach: `http://loinc.org`, `http://snomed.info/sct`, `http://www.nlm.nih.gov/research/umls/rxnorm`, `http://hl7.org/fhir/sid/ndc`, `http://hl7.org/fhir/sid/cvx`, `http://hl7.org/fhir/sid/icd-10-cm`, `http://hl7.org/fhir/sid/icd-9-cm`, `http://www.ama-assn.org/go/cpt` |
| `target_code` | the standard code |
| `target_display` | the standard display |
| `anchor_method` | how the row was derived: `dual-coding` (both codings present in the same target `code.coding`) \| `content-match` (target↔EHI matched by name/value/date) \| `value-set-literal` (fixed `_C_NAME`→code mapping) |
| `ehi_verified` | `yes` if `epic_local_code` was confirmed present in `ehi_join_table.ehi_join_column` (i.e. the join actually works against this export); else `no` |
| `confidence` | `high` (dual-coding + ehi_verified) \| `medium` (single anchor) \| `low` (fuzzy/ambiguous) |
| `notes` | ambiguity, 1:n fan-out, sentinel handling, etc. |

### Worked rows (illustrative)

```
problem,Condition.code,"Gastroesophageal reflux disease",PROBLEM_LIST,DX_ID,urn:oid:2.16.840.1.113883.3.247.1.1,8169,"Gastroesophageal reflux disease",http://hl7.org/fhir/sid/icd-10-cm,K21.9,"Gastro-esophageal reflux disease without esophagitis",dual-coding,yes,high,"also SNOMED 235595009 + ICD-9 530.81 as sibling rows"
lab,Observation.code,"BUN/Creatinine Ratio",ORDER_RESULTS,COMPONENT_ID,urn:oid:1.2.840.114350.1.13.283.2.7.2.768282,1510194,"BUN/Creatinine Ratio",http://loinc.org,3097-3,"Urea nitrogen/Creatinine [Mass Ratio] in Serum or Plasma",dual-coding,yes,high,
```

A 1:n concept (one local code → ICD-10 *and* SNOMED *and* ICD-9) becomes **multiple rows**,
one per `target_system`. That's the natural shape for a `JOIN`.

## How a generator would consume it

```sql
-- recover Condition.code.coding from the local DX_ID the EHI ships
SELECT x.target_system, x.target_code, x.target_display
FROM problem_crosswalk x
WHERE x.ehi_join_table='PROBLEM_LIST' AND x.epic_local_code = :DX_ID;
```

`ehi_verified=yes` rows are the ones that would actually fire against this export.

## Scope / honesty

This is an **excerpt**: it covers only the concepts present in this one patient's record (what
we could observe paired). It is reconstructed, not authoritative — Epic's real table is the
source of truth. `confidence`/`anchor_method`/`ehi_verified` let a consumer filter to the rows
they trust. Rows we could *not* anchor (standard code in the target but no matching Epic-local
code, or no EHI presence) are recorded with `ehi_verified=no` so the residual gap is explicit.
