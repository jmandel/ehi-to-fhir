# ChargeItem — gaps

Source: `ARPB_TRANSACTIONS` PB charge ledger (TX_TYPE_C_NAME='Charge', 29 rows).

## Status / value-set
- **[status]** No native Epic column maps to the required ChargeItemStatus value set
  (planned|billable|not-billable|aborted|billed|entered-in-error|unknown). Derived:
  `VOID_DATE` non-null → `entered-in-error` (1/29); otherwise `billable`. We do not read a
  "billed" flag, so we assert the conservative `billable` baseline for live charges.

## Codings (best-effort / omitted)
- **[coding] performer.function** — no procedure-performer role code in the EHI; performer.actor only.
- **[coding] code internal proc** — `CLARITY_EAP` ships only PROC_ID + PROC_NAME (no CPT column, §27);
  the transmitted CPT is recovered from the 835 service line (`CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`).
  Both codings emitted; the internal Epic code is asserted under the Epic EAP OID (unverified system).
- **[coding] priceOverride** — `AMOUNT` is the charged amount, mapped to `priceOverride` as the closest
  FHIR slot for "what this charge costs." It is not a true override of a ChargeItemDefinition list price
  (no list-price/ChargeItemDefinition data ships).
- **[coding] reason ICD-10** — `reason` carries the primary-dx **text only** (`CLARITY_EDG.DX_NAME`
  keyed on `PRIMARY_DX_ID`, 29/29). Contrary to the design doc's initial read, the ICD-10 *code* is
  NOT traceable per charge: `CLM_DX` holds ICD-10 values but keys on the claim-image `RECORD_ID` with
  no `DX_ID`; `CLARITY_EDG` ships no code column; the `INV_DX_INFO`→`INV_TX_PIECES` chain links a
  charge only to an unordered invoice dx *set* (by `DX_ID`, still no ICD-10), not to one code. Emitting
  an ICD-10 code would require an unsound join, so only dx text is emitted.
- **modifiers** — as-billed CPT modifiers (e.g. `HC:99213:95` → `95`) come ONLY from the transmitted
  835 service-line identifier (`CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`). They have no structured slot on
  R4 `Coding`/`ChargeItem`, so they are surfaced as a `code.text` suffix `[mod ...]` only. The ledger
  `ARPB_TRANSACTIONS.MODIFIER_ONE..FOUR` columns are **deliberately not used**: they are not a clean
  as-billed CPT-modifier source. They mix genuine CPT modifiers (the `25`/`95` rows, which are also
  present on the transmitted identifier) with Epic-internal posting flags such as `MCP` (11 charges).
  `MCP` is not a member of the CPT/HCPCS modifier set and is never transmitted on the claim
  (`SUBM_PROC_IDENT` is null for every `MCP` row), so labeling it `[mod MCP]` would be inaccurate.
  Because every genuine CPT modifier is already on the transmitted identifier, using only the
  transmitted list is both correct and complete.
- **[coding] CPT vs HCPCS** — the 835 `HC:` qualifier covers both CPT and HCPCS Level II; codes like
  `G2211`/`90471`/`90686` are HCPCS but are emitted under the AMA CPT system URI (the export does not
  distinguish them within the `HC` qualifier). Best-effort coding.

## References emitted / omitted
- **account** — EMITTED. `ARPB_TRANSACTIONS.ACCOUNT_ID` is present on all 29 charges
  (single value `1810018166`). The Account resource IS built (`src/account.ts` →
  `out/Account.json`, id `acct-1810018166`, subject `Patient/pat-Z7004242`), so
  `account: [ref('Account', id.account(ACCOUNT_ID))]` resolves with zero dangling. No longer a gap.
- **[reference] enterer** — `USER_ID` (e.g. DHILLOPS, or system user "EDI, FINANCIAL TRANSACTIONS")
  is an EMP user id. The project mints Practitioners only from SER providers (CLARITY_SER.PROV_ID);
  there is no Practitioner/PractitionerRole for EMP users, so `enterer` is omitted rather than dangling.
  `enteredDate` (POST_DATE) is still emitted.

## Not present in EHI (no source)
- definitionUri / definitionCanonical (no ChargeItemDefinition), partOf, requestingOrganization,
  factorOverride, overrideReason, product[x], supportingInformation, bodysite, note.
- **service** — no charge→ORDER_PROC/result link on the PB ledger; lab charges share a CSN with labs
  but there is no resolvable per-charge pointer to a built DiagnosticReport/Procedure/Immunization.

## Scope
- HB charges (`HSP_TRANSACTIONS`, 3 charge rows) are a separate ledger (PB/HB must never be mixed,
  gotcha 1) and are not mapped in phase 1.
