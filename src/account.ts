/**
 * account.ts — FHIR R4 Account from the Epic EHI export.
 *
 * Domain "account" (billing). Owns: Account.
 *
 * We model the EAR guarantor account (`ACCOUNT` master): the balancing/guarantor
 * entity that owns the patient's PB/HB balances and against which statements are
 * issued. Two rows in this specimen (4793998 SA10, 1810018166 SA18), both
 * "Personal/Family", both active. See coverage-and-billing.md §"Guarantor
 * account (EAR master)".
 *
 * ARPB_VISITS (PB per-visit) is still not modeled as Account. HSP_ACCOUNTs (HB
 * hospital accounts), however, ARE referenced by emitted Encounters (Encounter.account
 * -> Account/acct-<HSP_ACCOUNT_ID>), so for referential closure we emit one minimal-but-real
 * "Hospital Account" stub per distinct HSP_ACCOUNT_ID used by emitted encounters (here only
 * 376684810). These stubs carry only id + identifier + status + type + name + subject derived
 * from the real HSP_ACCOUNT row — no fabricated coverage/guarantor (see design/account.md).
 *
 * FIELD SOURCES
 *   id                 id.account(ACCOUNT_ID) (Epic's opaque FHIR id is not in the export)
 *   identifier         ACCOUNT.ACCOUNT_ID (= EPIC_ACCT_ID here), type.text "Account number".
 *                      The R4 IdentifierType value set has no account-number code, and the Epic
 *                      EAR master-file OID suffix is not verifiable from the export, so we assert
 *                      type as text + value only (no fabricated OID system). Coding gap.
 *   status             ACCOUNT.IS_ACTIVE → Y→active / N→inactive (required AccountStatus binding).
 *   type               ACCOUNT.ACCOUNT_TYPE_C_NAME ("Personal/Family") — text only; no standard
 *                      AccountType code derivable (binding is example). Coding gap.
 *   name               ACCOUNT.ACCOUNT_NAME (guarantor account display name).
 *   subject            ACCT_GUAR_PAT_INFO.PAT_ID restricted to this export's patient → patientRef()
 *                      (display derived, never hardcoded). The Father (Z8599632) on 1810018166 is
 *                      not a built resource and is excluded.
 *   coverage[]         ACCT_COVERAGE rows for the account → coverage.coverage = id.coverage(...),
 *                      coverage.priority = LINE (positiveInt).
 *   guarantor[]        ACCT_GUAR_PAT_INFO row for this patient (GUAR_REL_TO_PAT_C_NAME 'Self') →
 *                      guarantor.party = patientRef(). The EAR account's guarantor is the patient.
 *   owner              ACCOUNT.SERV_AREA_ID → id.organization(SERV_AREA_ID), ONLY when that org is
 *                      minted (location-org.ts mints org-18). SA10 has no minted org → owner omitted
 *                      for 4793998 rather than dangle a reference (gap).
 *
 * GAPS (see gaps/account.md)
 *   - identifier system: Epic EAR master-file OID suffix not verifiable → type+value only.
 *   - type coding: only text ("Personal/Family"); no standard AccountType code in the EHI.
 *   - servicePeriod / description / partOf / guarantor.onHold / guarantor.period: no source columns
 *     on the EAR guarantor account.
 *   - owner for account 4793998 (SERV_AREA 10): no Organization minted → omitted.
 *   - Account balances (ACCOUNT.TOTAL_BALANCE etc.): no balance element exists on R4 Account.
 *   - PB per-visit accounts (ARPB_VISITS) intentionally not modeled as Account.
 *   - HSP_ACCOUNT (HB) stubs emitted for referential closure only (Encounter.account targets);
 *     coverage/guarantor deliberately omitted from the stub.
 *
 * Everything is TEXT in the EHI (general-patterns §17); categories ship pre-resolved as
 * *_C_NAME with no ZC_ tables (§23).
 */
import { q } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { id, ref, patientRef, PATIENT_PAT_ID } from "../lib/ids";

function nn(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** IS_ACTIVE (Y/N) → AccountStatus. Required 1..1 binding. */
function statusFromActive(v: string | undefined): string {
  if (v === "Y") return "active";
  if (v === "N") return "inactive";
  return "unknown";
}

/** SERV_AREA_IDs for which location-org.ts mints an Organization (owner must resolve). */
const MINTED_ORG_SERV_AREAS = new Set(["18"]);

/** Epic hospital-account (HSP_ACCOUNT) identifier OID — mirrors SYS_HSP_ACCT in encounter.ts. */
const SYS_HSP_ACCT = "urn:oid:1.2.840.114350.1.13.283.2.7.2.726582";

/** ACCT_BILLSTS_HA_C_NAME → AccountStatus. "Closed" → inactive; everything else active. */
function statusFromBillSts(v: string | undefined): string {
  return v === "Closed" ? "inactive" : "active";
}

/**
 * Referential-closure stubs for HB hospital accounts referenced by emitted Encounters.
 * Encounter.account points at Account/acct-<HSP_ACCOUNT_ID>; we emit one minimal-but-real
 * Account per distinct HSP_ACCOUNT_ID used by emitted encounters so those refs resolve.
 * Minimal by design: no coverage/guarantor (not part of the closure requirement).
 */
function buildHospitalAccounts(): any[] {
  const out: any[] = [];

  const hars = q<any>(
    `SELECT DISTINCT HSP_ACCOUNT_ID
       FROM PAT_ENC
      WHERE HSP_ACCOUNT_ID IS NOT NULL AND TRIM(HSP_ACCOUNT_ID) <> ''
      ORDER BY CAST(HSP_ACCOUNT_ID AS INTEGER)`
  );

  for (const h of hars) {
    const harId = nn(h.HSP_ACCOUNT_ID);
    if (!harId) continue;

    const row = q<any>(
      `SELECT HSP_ACCOUNT_NAME, ACCT_BILLSTS_HA_C_NAME
         FROM HSP_ACCOUNT
        WHERE HSP_ACCOUNT_ID = ?`,
      harId
    )[0];
    if (!row) continue; // not real in the EHI → don't fabricate

    const patRef = patientRef();

    out.push(
      clean({
        resourceType: "Account",
        id: id.account(harId),
        identifier: [{ system: SYS_HSP_ACCT, value: harId }],
        status: statusFromBillSts(nn(row.ACCT_BILLSTS_HA_C_NAME)),
        type: { text: "Hospital Account" },
        name: nn(row.HSP_ACCOUNT_NAME),
        subject: [{ reference: patRef.reference, display: patRef.display }],
      })
    );
  }

  return out;
}

function buildAccounts(): any[] {
  const out: any[] = [];

  const rows = q<any>(
    `SELECT ACCOUNT_ID, ACCOUNT_NAME, ACCOUNT_TYPE_C_NAME, IS_ACTIVE, SERV_AREA_ID
       FROM ACCOUNT
      ORDER BY CAST(ACCOUNT_ID AS INTEGER)`
  );

  for (const a of rows) {
    const acctId = nn(a.ACCOUNT_ID);
    if (!acctId) continue;

    // --- identifier: Epic guarantor-account number. The R4 IdentifierType value set does
    // not contain an "account number" code, and the Epic EAR master-file OID suffix is not
    // verifiable from the export, so we assert the account-number type as text + value only.
    const identifier = [
      {
        type: { text: "Account number" },
        value: acctId,
      },
    ];

    // --- type: text only (no standard AccountType code derivable).
    const typeName = nn(a.ACCOUNT_TYPE_C_NAME);
    const type = typeName ? { text: typeName } : undefined;

    const patRef = patientRef();

    // --- subject + guarantor: this export's patient (Self) on this account.
    const guarRows = q<any>(
      `SELECT LINE, PAT_ID, GUAR_REL_TO_PAT_C_NAME
         FROM ACCT_GUAR_PAT_INFO
        WHERE ACCOUNT_ID = ? AND PAT_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      acctId,
      PATIENT_PAT_ID
    );

    const subject = guarRows.length
      ? [{ reference: patRef.reference, display: patRef.display }]
      : undefined;

    const guarantor = guarRows.length
      ? [{ party: { reference: patRef.reference, display: patRef.display } }]
      : undefined;

    // --- coverage[]: account→coverage bridge (priority = LINE).
    const covRows = q<any>(
      `SELECT LINE, COVERAGE_ID
         FROM ACCT_COVERAGE
        WHERE ACCOUNT_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      acctId
    );
    const coverage = covRows
      .map((c: any) => {
        const covId = nn(c.COVERAGE_ID);
        if (!covId) return undefined;
        const line = nn(c.LINE);
        const priority = line && /^\d+$/.test(line) && Number(line) > 0 ? Number(line) : undefined;
        return clean({
          coverage: ref("Coverage", id.coverage(covId)),
          priority,
        });
      })
      .filter(Boolean);

    // --- owner: only when the service-area Organization is actually minted.
    const saId = nn(a.SERV_AREA_ID);
    const owner =
      saId && MINTED_ORG_SERV_AREAS.has(saId)
        ? ref("Organization", id.organization(saId), saName(saId))
        : undefined;

    out.push(
      clean({
        resourceType: "Account",
        id: id.account(acctId),
        identifier,
        status: statusFromActive(nn(a.IS_ACTIVE)),
        type,
        name: nn(a.ACCOUNT_NAME),
        subject,
        coverage: coverage.length ? coverage : undefined,
        owner,
        guarantor,
      })
    );
  }

  return out;
}

/** Owner display from CLARITY_SA (EXTERNAL_NAME preferred, else SERV_AREA_NAME). */
function saName(servAreaId: string): string | undefined {
  const r = q<{ SERV_AREA_NAME: string | null; EXTERNAL_NAME: string | null }>(
    `SELECT SERV_AREA_NAME, EXTERNAL_NAME FROM CLARITY_SA WHERE SERV_AREA_ID = ?`,
    servAreaId
  )[0];
  return nn(r?.EXTERNAL_NAME) ?? nn(r?.SERV_AREA_NAME);
}

emit("Account", [...buildAccounts(), ...buildHospitalAccounts()]);
