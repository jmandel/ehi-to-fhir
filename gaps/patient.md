# Patient — reconstruction gaps

Generated from `src/patient.ts`. `bun compare.ts Patient` → generated 1 / target 1, **zero
EXTRA/fabricated paths**. The patient `id` is `pat-Z7004242` (= `id.patient()`), so every
cross-resource `Patient/...` reference resolves. This specimen is a **value-consistent redacted
copy**: MRN, phones, emails, street address and contact names ship as stable `[REDACTED-…]`
tokens; we emit the EHI's value verbatim (a token is the datum, not an invention).

Each gap is tagged **[coding]** (the value/text is preserved but a terminology code could not be
recovered) or **[data]** (the datum itself is absent or unreachable in this export).

## Residual MISSING paths (present in target, not generatable here)

_None._ The two fields previously listed here — `maritalStatus` and the `usual` preferred name
with the iso21090-EN `CL` qualifier — were **false absences**; both are now sourced and emitted
(see "Recovered from cross-domain / supplement sources" below).

## Recovered from cross-domain / supplement sources (the anti-silo fixes)

These three were once written off as absent; the whole-export search gate found the real source.

- **`maritalStatus`** ← **`CLM_VALUES.PAT_MAR_STAT`** — **[data, recovered]**. The X12-837
  patient marital status code is stamped on every claim. `CLM_VALUES` has no `PAT_ID`; we join by
  `PAT_MRN` (= `PATIENT.PAT_MRN_ID`, byte-identical incl. the redaction token) and take the
  dominant (most-frequent) code as the current status. For this patient `PAT_MAR_STAT='1'`
  dominates 13:6 over `'2'`. No in-export label table (`SELECT name FROM sqlite_master ... LIKE
  '%MARITAL%'` → 0 tables; no `ZC_`), so a fixed numeric→label map recovers `'1'` → text
  "Married" (same convention as the OMB-race / bcp-47 maps). Emitted **text-only**: no marital
  terminology code is present in the export, and the target also carries `maritalStatus` as
  text-only — emitting a coding would fabricate an EXTRA path. Only the export-verified category
  `'1'` is mapped; `'2'` is left unmapped (no in-export evidence for its label — never guess).
  Matches target `maritalStatus.text='Married'` exactly.
  _Prior false claim_: "Not materialized anywhere in this export" — only `PATIENT*`,
  `PATIENT_MISC_COMMENTS.MARITAL_STAT_C_CMT` (NULL) and `V_EHI_COVERAGE_SUBS.SUBSCRIBER_MARITAL_
  STATUS_C_NAME` (NULL) had been checked; `bun tools/find-concept.ts marital` flags
  `CLM_VALUES.PAT_MAR_STAT` POPULATED (20 rows).

- **`name[use=usual]` + `name[]._given[].extension` (iso21090-EN `CL`)** ←
  **`PATIENT_3.PREFERRED_NAME`** (+ **`PATIENT_5.PREFERRED_NAME_TYPE_C_NAME`**) —
  **[data, recovered]**. `PATIENT_3.PREFERRED_NAME='Josh'` is the structured preferred FIRST name;
  `PATIENT_5.PREFERRED_NAME_TYPE_C_NAME='First Name, Preferred'` confirms it is the *first* name
  that is preferred. We emit a `usual` name `given=[PREFERRED_NAME, PAT_MIDDLE_NAME]`,
  `family=PAT_LAST_NAME`, tagging only the preferred-first given part with the `CL` (call-me)
  qualifier via the parallel `_given` array (trailing-null position for the middle part omitted
  per FHIR). Suppressed when the preferred first equals the legal first (no distinct usual form).
  Result `"Josh C Mandel"` matches target byte-for-byte.
  _Prior false claim_: "PATIENT_5.PREFERRED_NAME_TYPE_C_NAME/PREFERRED_FORM_ADDRESS are NULL" —
  `PREFERRED_FORM_ADDRESS` is NULL but `PREFERRED_NAME_TYPE_C_NAME` is **populated**.

- **`identifier` PayerMemberId** (`https://open.epic.com/FHIR/StructureDefinition/PayerMemberId`)
  ← **`COVERAGE_MEMBER_LIST.MEM_NUMBER`** — **[data, recovered]**. The patient's own coverage
  member number lives on the Coverage-domain `COVERAGE_MEMBER_LIST` row keyed to this `PAT_ID`
  with `MEM_REL_TO_SUB_C_NAME='Self'` → `MEM_NUMBER='MSJ60249687901'`, byte-identical to the
  target's PayerMemberId. We emit each distinct Self member number. Cross-domain but the same
  per-patient datum.
  _Prior false claim_: "no source column carries these values" — `bun tools/find-concept.ts
  --grep MSJ60249687901` hits `COVERAGE_MEMBER_LIST` (and `V_EHI_COVERAGE_SUBS`).

## Per-field codings emitted as best-effort (text/value kept, code recovered or omitted)

- **`extension` legal-sex / genderIdentity** — **[coding, recovered by convention]**.
  `PATIENT.SEX_C_NAME` and `PATIENT_4.GENDER_IDENTITY_C_NAME` ship as labels only (no `ZC_`, no
  bare `_C`, §23). We emit the label as `text` and a lowercase `code` under the well-known
  systems the target uses (open.epic legal-sex value-set OID; `hl7.org/fhir/gender-identity`).
  The *integer* category code Epic assigned is unrecoverable.

- **us-core-race / us-core-ethnicity OMB codes** — **[coding, recovered by display map]**.
  `PATIENT_RACE.PATIENT_RACE_C_NAME` ("White") and `PATIENT.ETHNIC_GROUP_C_NAME` ("Not Hispanic
  or Latino") ship as labels only. The OMB codes (`2106-3`, `2186-5`, system
  `urn:oid:2.16.840.1.113883.6.238`) are recovered deterministically from a fixed display→code
  map for the standard OMB categories; a non-standard label would yield `text` only.

- **communication language bcp-47 code** — **[coding, recovered by display map]**.
  `PATIENT.LANGUAGE_C_NAME` = "English" → `en` via a small fixed map; `text` is always the label.
  Spoken/written proficiency (`ESP`/`EWR`) and preference type (`verbal`/`written`) are derived
  faithfully from which EHI modality column is populated (`LANGUAGE_C_NAME` = spoken/care,
  `LANG_WRIT_C_NAME` = written). `LANG_CARE_C_NAME` is NULL here.

- **`contact[].relationship` v3-RoleCode (`SPS`) + Epic relationship OID (`17`)** — **[coding]**.
  `PAT_RELATIONSHIPS.PAT_REL_RELATION_C_NAME` = "Spouse" ships as a label only (no `ZC_`). We
  emit it as `relationship[].text` and add the v2-0131 `C` (Emergency Contact) coding only
  because `PAT_RELATIONSHIP_LIST.EMERG_CONTACT_YN` = `Y` is a real boolean in the export. The
  `SPS` (v3-RoleCode) and Epic `17` codes are not recoverable. The Employer contact's v2-0131
  `E` coding is emitted (employer is a structural role on `PATIENT.EMPLOYER_ID*`).

## Identifiers — emitted vs omitted

Emitted (values real in the export):
- **EPI** `[MRN-EPI-REDACTED]` (system `…737384.0`) — `IDENTITY_ID` type EPI.
- **MRN MAPL** (system `…737384.955`) — `IDENTITY_ID` type "MRN MAPL", type id 955 = the OID's
  trailing node; value = `PATIENT.PAT_MRN_ID` (byte-identical, verified). Redacted token here.
- **IHSMRN** `[MRN-IHS-REDACTED]` (system `…283`) — `IDENTITY_ID` type IHS.
- **EXTERNAL** / **INTERNAL** `Z7004242` / `  Z7004242` (system `…2.698084`) — `PATIENT.PAT_ID`,
  the EPT key (INTERNAL is left-padded as the target shows).
- **WPRINTERNAL** `389635` (system `…2.878082`) — `PATIENT_MYC.MYPT_ID`.
- **PayerMemberId** `MSJ60249687901` (system `open.epic …/PayerMemberId`) —
  `COVERAGE_MEMBER_LIST.MEM_NUMBER` (Self row). _(recovered — see above.)_

Omitted — **[data]**, confirmed absent. Each line records the search that proves it (so the
absence is falsifiable, not asserted):
- **FHIR** (`patient-dstu2-fhir-id`) and **FHIR STU3** (`patient-fhir-id`, also the target's
  resource `id`) — opaque server-minted tokens `TmI-PYc6…` / `euBTtyZGh3f…`. Proof:
  `bun tools/find-concept.ts --grep 'TmI-PYc6|euBTtyZGh3f'` → 0 raw tables; `find-concept FHIR`
  surfaces only Coverage-level FHIR id columns (`CLM_VALUES_5.FHIR_GROUP_IDENTIFIER`,
  `COVERAGE_2.EXT_CVG_FHIR_IDENT`) — none being the Patient resource's id;
  `PAT_FHIR_MERGE_UNMERGE.SRC_PAT_FHIR_IDENTIFIER` is empty/not-shipped.
- **CEID** (`…3.688884.100`, value `[CEID-REDACTED]`) — Proof: `find-concept --grep
  [CEID-REDACTED]` → 0 raw tables; `--grep 688884` → 0; schema search `CEID` → 0 columns.
- **MYCHARTLOGIN** (`…3.878082.110`, value `[NAME-REDACTED]`) — Proof: `find-concept --grep [NAME-REDACTED]`
  → 0 raw tables; `find-concept login` shows no patient-login value column populated
  (`PATIENT_MYC` has only `MYCHART_EXP_DATE`; `MYC_PATIENT` carries only `MYPT_ID`).
- **APL** surface form (`[MRN-APL-REDACTED]`) — **[partial]**. The target labels the org MRN "APL" with a
  formatted surface value; that literal string is absent (`find-concept --grep 'APL[0-9]'` → 0
  raw tables). The SAME identifier datum IS emitted as the org MRN (`IDENTITY_ID` type "MRN MAPL",
  type id 955, value = `PATIENT.PAT_MRN_ID`) under system `…737384.955`. We keep the EHI's label
  and value rather than fabricate the "APL"-formatted surface value.

## Other target fields not reproduced

- **us-core-sex (`184115007`) and us-core-genderIdentity (SNOMED `446151000124109`)
  extensions** — **[coding]**. These two extra extensions in the target carry SNOMED codes that
  do not appear in the EHI (`PATIENT_4` ships only the `SEX_ASGN_AT_BIRTH_C_NAME` /
  `GENDER_IDENTITY_C_NAME` labels). The same concepts are already emitted via the birthsex /
  genderIdentity / legal-sex extensions from those labels; we do not fabricate the SNOMED codes.
  (No path is left MISSING by this — all are under the already-covered `extension[]` paths.)

## Notes on faithfulness

- **Alive/deceased** is taken from `PATIENT_4.PAT_LIVING_STAT_C_NAME` = "Alive" (authoritative,
  demographics gotcha 1), corroborated by a NULL `PATIENT.DEATH_DATE`. → `active: true`,
  `deceasedBoolean: false`. If a death date were present we would emit `deceasedDateTime`.
- **Alias names** keep the EHI's exact packed casing (`MANDEL,JOSH` → family `MANDEL`,
  given `JOSH`, text `MANDEL,JOSH`); the target's title-cased rendering is a presentation
  transform we do not impose on the parsed parts. The `text` is verbatim.
- **State/country** labels are mapped to the abbreviations the target uses
  (Wisconsin→WI, United States of America→USA); the raw label is preserved in `address[].text`.
- **generalPractitioner** → `Practitioner/prac-144590` (`PATIENT.CUR_PCP_PROV_ID`, resolves in
  `out/Practitioner.json`); **managingOrganization** → `Organization/org-18` (facility service
  area `CLARITY_SA` 18 "MAC ASSOCIATED PHYSICIANS LLP", resolves in `out/Organization.json`).
