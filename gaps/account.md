# Account — gaps

Scope: we model the 2 EAR guarantor accounts (`ACCOUNT`) as FHIR Account. The following
elements/instances could not be fully populated from the EHI.

## Coding gaps
- **`type` coding.** `ACCOUNT.ACCOUNT_TYPE_C_NAME` = "Personal/Family" is emitted as text
  only. FHIR `Account.type` binds (example strength) to AccountTypes; there is no
  standard-code crosswalk in the EHI, so no `coding` is asserted.
- **`identifier[].type` coding + `system`.** The account number (`ACCOUNT.ACCOUNT_ID`, =
  `EPIC_ACCT_ID` here) is emitted with `type.text = "Account number"` + value. The R4
  `IdentifierType` value set contains no account-number code, so no bound coding can be
  asserted (validator's `preferred`-binding warning is unsatisfiable, not a data gap). The
  Epic EAR master-file OID suffix is not verifiable from the export, so no `system` URN is
  asserted rather than fabricate one. (This leaves 2 advisory warnings/account: the
  IdentifierType binding above and the generic dom-6 "should have narrative" best-practice.)

## Element gaps (no source column)
- **`servicePeriod`.** The EAR guarantor account has no service date range; admit/discharge
  periods live on the per-encounter HARs (`HSP_ACCOUNT.ADM_DATE_TIME`/`DISCH_DATE_TIME`),
  which we do not model as Account. Omitted.
- **`owner` for account 4793998.** Its `SERV_AREA_ID` = 10 ("UnityPoint Health Service
  Area"); location-org.ts mints an Organization only for SERV_AREA 18 (and the payer 1302),
  so emitting `owner` here would dangle. Omitted rather than fabricate. Account 1810018166
  (SERV_AREA 18) does get `owner = Organization/org-18`.
- **`guarantor.onHold`.** No credit-hold boolean. `STMT_HOLD_DT`/`STMT_HOLD_REASON_C_NAME`
  are statement-hold, not a guarantor credit hold; not mapped. Omitted.
- **`guarantor.period`.** No guarantor effective-period column. Omitted.
- **`description`.** No free-text purpose/use column. Omitted.
- **`partOf`.** No parent-account relationship modeled. Omitted.

## Scope gaps (modeled elsewhere / not modeled)
- **Balances.** `TOTAL_BALANCE` / `INSURANCE_BALANCE` / `PATIENT_BALANCE` / `HB_*_BALANCE`
  have no native home on FHIR R4 `Account` (no balance element in R4). Not emitted.
- **PB visits (`ARPB_VISITS`, 20).** Per-encounter PB HARs — redundant with Encounter +
  the claim chain; not modeled as Account.
- **HB HARs (`HSP_ACCOUNT`, 4).** Hospital-billing episodes (one real Therapies Series
  episode + summary HARs). Carry a service period and class but no independent
  guarantor/subject. Not modeled here; a future pass could emit them as `type = HB`
  accounts with `servicePeriod` from ADM/DISCH and `subject = patient`.
- **Second subject on account 1810018166.** `ACCT_GUAR_PAT_INFO` lists a Father
  (PAT_ID Z8599632, "Father") in addition to Self. We restrict `subject`/`guarantor` to the
  export's patient; the family member is out of export scope.
