# Account — design (group: billing)

**Resource:** FHIR R4 `Account` (https://hl7.org/fhir/R4/account.html)
**Generator (phase 2):** `src/account.ts` → `out/Account.json` via `emit("Account", ...)`
**Verdict:** **BUILD.**

## What an Account is, and what we model

A FHIR `Account` is "a financial tool for tracking value accrued for a particular
entity… used to convey charges and balances." In Epic terms the closest match is the
**EAR guarantor account** (`ACCOUNT` master): the balancing/guarantor entity that owns
PB + HB balances and against which statements are issued. That is what we emit.

We deliberately do **not** mint an Account per encounter-level HAR:
- `ARPB_VISITS` (20 PB visits / per-encounter PB HARs) are the PB grouping between the
  CSN and the invoice; they belong to the claim/encounter machinery (each has a
  `PRIM_ENC_CSN_ID`) and carry no balance/owner/name of their own beyond what the
  guarantor account + Encounter already express. Modeling them as Account would inflate
  the resource 10× with encounter-redundant shells.
- `HSP_ACCOUNT` (4 HB HARs) are hospital-billing episodes. They carry an admit/discharge
  service period and a class, but no guarantor/subject of their own (subject is reached
  only back through the same EAR guarantor), and the one real HB episode is already
  represented by its Encounter + Coverage + (future) claim resources. Out of scope here;
  noted as a gap so a later pass could add them as `type = HB` accounts if wanted.

So the populatable set = the rows of `ACCOUNT` = **2 instances** (both this patient's
guarantor accounts: `4793998` and `1810018166`, both "Personal/Family", both active).

## Source tables

| table | role | rows | use |
|---|---|---|---|
| `ACCOUNT` (EAR master) | guarantor account | 2 | the Account spine (id, name, type, status, owner) |
| `ACCT_GUAR_PAT_INFO` | guarantor → patient bridge `(ACCOUNT_ID, LINE) → PAT_ID` | 3 | `subject` + `guarantor.party` (filter to this patient) |
| `ACCT_COVERAGE` | account → coverage bridge `(ACCOUNT_ID, LINE) → COVERAGE_ID` | 2 | `coverage[].coverage` + `coverage[].priority` (LINE) |
| `CLARITY_SA` | service-area master `SERV_AREA_ID → name` | — | resolve `owner` org name / id |

`PAT_ACCT_CVG` (patient-side mirror) and `CVG_ACCT_LIST` (coverage-side mirror) corroborate
the same account↔coverage↔patient triangle; `ACCT_COVERAGE` is the account-keyed leg we use.

## Element → EHI source mapping

| FHIR element | card | source | notes |
|---|---|---|---|
| `id` | — | `id.account(ACCOUNT_ID)` | minter already defined in `lib/ids` |
| `identifier` | 0..* | `ACCOUNT.ACCOUNT_ID` under Epic EAR master-file OID | same convention as coverage.ts (`urn:oid:1.2.840.114350.1.13.283.2.7.2.<INI>`); EAR record. Also `EPIC_ACCT_ID` (= same value here). |
| **`status`** | **1..1 (req)** | `ACCOUNT.IS_ACTIVE` → `Y`→`active`, `N`→`inactive` | required AccountStatus value set (active/inactive/entered-in-error/on-hold/unknown). Both rows `Y`. |
| `type` | 0..1 | `ACCOUNT.ACCOUNT_TYPE_C_NAME` ("Personal/Family") | text only — no FHIR AccountType code derivable (binding is *example*). Record [coding] gap. |
| `name` | 0..1 | `ACCOUNT.ACCOUNT_NAME` ("MANDEL,JOSHUA C") | guarantor account display name. |
| `subject` | 0..* | `ACCT_GUAR_PAT_INFO.PAT_ID` (this patient) → `patientRef()` | the entity incurring expenses. Display derived via `patientRef()` (never hardcoded). Account 1810018166 also lists a Father (Z8599632) we don't build — subject is restricted to the export's patient. |
| `servicePeriod` | 0..1 | — | no service period on the EAR guarantor account (that lives on the per-encounter HARs). Omit. Gap. |
| `coverage` | 0..* | `ACCT_COVERAGE` rows for the account | one entry per bridge row. |
| `coverage.coverage` | 1..1 (req) | `ACCT_COVERAGE.COVERAGE_ID` → `id.coverage(...)` | resolves to the Coverage we mint (5934765). |
| `coverage.priority` | 0..1 | `ACCT_COVERAGE.LINE` (positiveInt) | line order = priority. |
| `owner` | 0..1 | `ACCOUNT.SERV_AREA_ID` → `id.organization(SERV_AREA_ID)` | **emit only when the org is minted.** location-org.ts mints `org-18` (SERV_AREA 18) + `org-1302` (payer). So owner resolves for account 1810018166 (SA 18 = "MAC ASSOCIATED PHYSICIANS LLP"); account 4793998 is SA 10 (not minted) → omit owner (gap) rather than dangle. Display from `CLARITY_SA.SERV_AREA_NAME`/`EXTERNAL_NAME`. |
| `description` | 0..1 | — | no free-text purpose column; omit. |
| `guarantor` | 0..* | `ACCT_GUAR_PAT_INFO` (rel = Self for this patient) | the EAR account *is* the guarantor; the guarantor party is the patient (Self). |
| `guarantor.party` | 1..1 (req) | this patient → `patientRef()` | `GUAR_REL_TO_PAT_C_NAME = 'Self'`. |
| `guarantor.onHold` | 0..1 | — | no credit-hold flag mapped (STMT_HOLD_* are statement-hold, not guarantor onHold). Omit. |
| `guarantor.period` | 0..1 | — | no guarantor effective period column. Omit. |
| `partOf` | 0..1 | — | no parent-account relationship modeled. Omit. |

## Required-element coverage

- `status` (1..1): **covered** from `IS_ACTIVE` (Y/N → active/inactive). ✔
- `coverage.coverage` (1..1, when coverage present): **covered** via `ACCT_COVERAGE` → `id.coverage`. ✔
- `guarantor.party` (1..1, when guarantor present): **covered** via `patientRef()`. ✔
- `subject` and other top-level elements are 0..*, no other required fields.

All FHIR-required elements are satisfiable for **2/2** instances. References (`coverage.coverage`,
`guarantor.party`, `subject`, and `owner` where emitted) all resolve to ids other generators mint
(Coverage 5934765, this Patient, Organization org-18).

## Populatable count estimate

**2** Account resources (the two EAR guarantor accounts), each with: identifier, status,
type (text), name, subject, guarantor.party (Self), and ≥1 coverage entry. One of the two
(1810018166) also gets `owner` (org-18).

## Gaps (see gaps/account.md)
- `type` coding: only text ("Personal/Family"); no standard AccountType code in EHI.
- `servicePeriod`: not on the guarantor account.
- `owner` for account 4793998 (SERV_AREA 10): no Organization minted → omitted.
- `guarantor.onHold` / `guarantor.period` / `description` / `partOf`: no source columns.
- Encounter-level HARs (`ARPB_VISITS` ×20, `HSP_ACCOUNT` ×4) intentionally not modeled as
  Account (redundant with Encounter/Coverage/claim); HB HARs could be a future `type=HB` pass.
