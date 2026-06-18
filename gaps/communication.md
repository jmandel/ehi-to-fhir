# Communication — gaps

Source: `MYC_MESG` (+ `MYC_MESG_RTF_TEXT` / `MSG_TXT` bodies, `MYC_MESG_CHILD`,
`MYC_MESG_ORD_ITEMS`, `MYC_MESG_CNCL_RSN`, `PAT_MYC_MESG`). 116 messages.
No fhir-target/ reference exists for Communication — gaps are vs the FHIR R4 definition.

## Element gaps (no EHI source → omitted)

- **received** — no receipt-instant column. `DELIVERY_DTTM` is NULL on all 116;
  `EOW_READ_STATUS_C_NAME` is a Read/unset flag (recipient read-state, not a timestamp, and
  set on only 50/116); `UPDATE_DATE` is the last-edit instant, not a receipt. Omitted.
- **priority** — no urgency/priority column on `MYC_MESG`. Omitted (RequestPriority is a
  required-if-present binding; omission beats guessing "routine").
- **statusReason** — no not-done/cancel reason on the header; no message is "not-done"
  (`RECORD_STATUS_C_NAME` NULL on all 116). Omitted.
- **reasonCode / reasonReference** — no coded reason / linked Condition/Observation/Report.
- **basedOn / partOf / instantiatesCanonical / instantiatesUri** — no EHI source.

## Reference / id-space gaps

- **Care-team party reference (sender/recipient)** — the non-patient party id
  (`FROM_USER_ID`/`TO_USER_ID`) is an **EMP/MyChart user** id, a different id space from the
  Practitioner minter (SER `PROV_ID`) — general-patterns §41/§48. We emit a Practitioner
  reference only when the party's `_NAME` exactly+uniquely matches a `CLARITY_SER.PROV_NAME`
  (and isn't a dropped sentinel). Parties with no unambiguous SER match — notably the system
  sender **"MYCHART, GENERIC"** (`MYCHARTG`/`E1011`, dropped by practitioner.ts) and several
  MA/coordinator/admin users (e.g. "GAIER, TERESA L", "DANNINGER, GAYLA J", "FARGEN, MEGAN")
  — are emitted **display-only** (no `reference`). [reference] gap: not all care-team actors
  resolve to a Practitioner.
- **PROV_ID (in-basket pool owner) and DEPARTMENT_ID** — `PROV_ID` is the addressed pool/
  filing provider, not the acting author (§48); it is not the sender, so it has no faithful
  Communication slot and is dropped. `DEPARTMENT_ID` (answering department) likewise has no
  Communication element. Recorded here, not emitted.

## Encounter linkage gap

- **encounter** — 86/116 messages carry `PAT_ENC_CSN_ID` (42 distinct CSNs), but the Encounter
  generator emits a curated subset; only **16** of those 42 message CSNs are produced as
  Encounter resources. We emit `encounter` only for messages whose CSN is in that set
  (avoiding dangling references, mapping principle 4). The other ~70 CSN-bearing messages get
  no `encounter` — a downstream consequence of the Encounter generator's Epic-API-curation
  approximation, not a Communication data gap.

## Coding gaps

- **topic** — `{ text }` from `SUBJECT` only; MyChart subject lines have no coded value.
- **category** — CommunicationCategory is an example binding; we only mark `notification` when
  the system sender is unambiguous, else omit. No native Epic category code is exported.
- **medium** — emitted as the ParticipationMode `ELECTRONIC` constant (structural truth: all
  are electronic MyChart messages), not from a per-row EHI column.

## Body / content notes

- **RTF stripping** — 90 bodies are RTF (`MYC_MESG_RTF_TEXT`). The task-named `../lib/rtf2txt`
  does not exist in lib/; stripping is implemented inline in `src/communication.ts`. The
  `{\*\revtbl{Unknown;}}` letter-template artifact (4 messages) is stripped so the literal
  "Unknown;" placeholder does not leak into `contentString` (messaging guide §unstructured).
- **Quote chains** — 7 older plain-text reply bodies append prior replies as
  `----- Message -----` blocks; kept verbatim (that is the body as stored/seen).
- **Questionnaire-submission stubs** — newer "Questionnaire Submission" bodies are template
  stubs ("Your response has been received."); the externalized answers
  (`MYC_MESG_QUESR_ANS.QUESR_ANS_ID` → HQA) are NOT in this export, so the answer content is
  unrecoverable. The stub body is emitted faithfully.

## Validator result

`bun tools/validate.ts Communication` → **0 errors, 116 warnings, 0 info**. The only warning
is the project-wide best-practice constraint **dom-6** ("a resource should have narrative for
robust management"), one per resource — no generator in this project emits narrative, so this
is the expected baseline, not a data gap.
</content>
