# Communication — design (group: secure-communications)

**Resource:** FHIR R4 `Communication` (https://hl7.org/fhir/R4/communication.html)
**Generator (phase 2):** `src/communication.ts` → `out/Communication.json` via `emit("Communication", ...)`
**Verdict:** **BUILD.**

There is **no** fhir-target/ reference for Communication; the spec is the R4 definition +
the EHI data + the messaging field guide. QA = official FHIR validator + adversarial review.

## What a Communication is, and what we model

A FHIR `Communication` is "an occurrence of information being transferred… the event of a
patient being notified, an alert being sent to a responsible provider, a public health
agency being notified about a reportable condition." That is exactly an Epic **MyChart secure
message**: one row per send/direction in `MYC_MESG`, each with a body, parties, a subject, a
sent instant, and reply threading. We emit **one Communication per `MYC_MESG` row** — these
are completed historical events, so `status = completed` (Communication, not CommunicationRequest).

Every one of the **116** messages has a reassemblable body (90 RTF + 26 plain, 0 missing) and
a `CREATED_TIME` send instant, so all 116 are populatable with the required `status`, a real
`sent`, a real `subject` (the patient), a real `sender`/`recipient` pair, and a `payload`.

## Source tables

| table | role | rows | use |
|---|---|---|---|
| `MYC_MESG` | spine — one row per message send (PK `MESSAGE_ID`) | 116 | id, sent, subject(topic), direction, parties, parent, csn |
| `MYC_MESG_RTF_TEXT` | RTF body, line-chunked `(MESSAGE_ID, LINE, RTF_TXT)` | 669 | `payload.contentString` for the 90 newer messages (RTF-stripped) |
| `MSG_TXT` | plain-text body, line-chunked `(MESSAGE_ID, LINE, MSG_TXT)` | 435 | `payload.contentString` for the 26 older messages |
| `MYC_MESG_ORD_ITEMS` | renewal-request order link `(MESSAGE_ID, LINE, REN_REQ_ORDER_ID)` | 3 | `about` → MedicationRequest (all 3 resolve in `ORDER_MED`) |
| `CLARITY_SER` | provider master | — | resolve a care-team party to a Practitioner *only* by exact unique `PROV_NAME` match |
| `PAT_ENC` | encounter contact | — | gate `encounter` to CSNs the Encounter generator actually emits |

Body stores partition the 116 messages with zero overlap / zero gaps (messaging guide). The
task named `../lib/rtf2txt`; **no such file exists in lib/**, so RTF→text is stripped inline.

## Party model (general-patterns §41/§48)

- **From Patient** (62): sender = the patient (`patientRef()`); recipient = the addressed
  care-team user `TO_USER_ID(_NAME)` (42 named; 20 unaddressed → recipient omitted).
- **To Patient** (54): sender = the answering user `FROM_USER_ID(_NAME)` (54/54 named);
  recipient = the patient.

The care-team party id is an **EMP/MyChart user** id, a different id space from our
Practitioner minter (SER `PROV_ID`). We mint a `Practitioner` reference for a care-team party
**only** when its `_NAME` exactly+uniquely matches a `CLARITY_SER.PROV_NAME` and is not a
dropped sentinel; otherwise the party is **display-only** (`{ display }`, no `reference`) so
nothing dangles. `PROV_ID` itself is the in-basket *pool owner* (the addressed doctor), not the
acting author — it is **not** the sender, so it is not used for sender/recipient.

## Element → EHI source mapping

| FHIR element | card | source | notes |
|---|---|---|---|
| `id` | — | `id.communication(MESSAGE_ID)` | minter already defined in `lib/ids` |
| `identifier` | 0..* | `MYC_MESG.MESSAGE_ID` under Epic MyChart-message master OID | structural id namespace, same OID convention as other generators (`…2.7.2.<INI>`) |
| **`status`** | **1..1 (req)** | constant `completed` | all are completed sends; `RECORD_STATUS_C_NAME` NULL on all 116 → none entered-in-error/not-done. EventStatus binding (required). |
| `category` | 0..* | system-sender bucket | `{ text: "notification" }` only for unambiguous system sends ("MYCHART, GENERIC"); else omit. CommunicationCategory binding is *example*; no native Epic category code exported. |
| `medium` | 0..* | constant ELECTRONIC | ParticipationMode `ELECTRONIC` — structural truth (all MyChart messages are electronic), not a per-row column. Example binding. |
| `subject` | 0..1 | `patientRef()` | the message is always about / addressed to/from this patient; `PAT_ID` on all 116. Display derived, never hardcoded. |
| `topic` | 0..1 | `MYC_MESG.SUBJECT` | `{ text }` only — subject lines have no coded value. |
| `sent` | 0..1 | `MYC_MESG.CREATED_TIME` ("M/D/YYYY h:mm:ss AM" → Chicago→ISO) | the send instant; populated on all 116. |
| `sender` | 0..1 | direction-dependent (see party model) | patient (To Patient: the user) — Practitioner ref when SER-resolvable, else display-only. |
| `recipient` | 0..* | direction-dependent (see party model) | the patient or the addressed user. |
| `inResponseTo` | 0..* | `MYC_MESG.PARENT_MESSAGE_ID` → `id.communication(...)` | all 44 parents resolve to a `MYC_MESG` row, so the ref always resolves. Reference(Communication). |
| `encounter` | 0..1 | `MYC_MESG.PAT_ENC_CSN_ID` → `id.encounter(...)` | **gated:** emit only when the CSN is in the Encounter generator's emitted set (16 of 42 message CSNs) to avoid dangling refs (principle 4). |
| `about` | 0..* | `MYC_MESG_ORD_ITEMS.REN_REQ_ORDER_ID` → `id.medicationRequest(...)` | renewal-request messages (3); all 3 ids resolve in `ORDER_MED`. Reference(Any). |
| `payload` | 0..* | reassembled body | one payload entry per message. |
| `payload.content[x]` | 1..1 (req) | `contentString` from RTF/plain body | RTF-stripped (incl. `revtbl`/`Unknown;` trap); plain kept verbatim incl. `----- Message -----` quote tails. |

## Required-element coverage

- **`status` (1..1):** covered — constant `completed` (EventStatus). ✔
- **`payload.content[x]` (1..1, when payload present):** covered — every message has a body
  (`contentString`). ✔
- `subject`, `sender`, `recipient`, `sent`, `topic` are all 0..* / 0..1 but populatable on
  effectively all 116. No other required top-level element.

All FHIR-required elements are satisfiable for **116/116** instances. All emitted references
(`inResponseTo`, `encounter` (gated), `about`, and Practitioner sender/recipient (gated))
resolve to ids other generators mint, or are omitted rather than dangled.

## Populatable count estimate

**116** Communication resources — one per `MYC_MESG` row. Each carries: identifier, status,
subject, topic (subject line), sent, a payload body, and a sender/recipient pair (patient on
one side; the care-team user on the other as a Practitioner ref where SER-resolvable, else
display-only). 44 also carry `inResponseTo`; 16 carry `encounter`; 3 carry `about`
(MedicationRequest). This is a large, non-trivial, non-redundant resource set — no other
resource we build represents these messages — hence **BUILD**.

## Gaps (see gaps/communication.md)
- `received`, `priority`, `statusReason`, `reasonCode/Reference`, `basedOn/partOf/instantiates*`:
  no EHI source.
- care-team party that has no unambiguous `CLARITY_SER` match (system sender "MYCHART, GENERIC",
  several MA/coordinator users) → display-only, no Practitioner reference.
- `encounter` for the ~70 CSN-bearing messages whose CSN the Encounter generator doesn't emit.
- `topic`/`category`/`medium` codings: text/constant only (no native Epic codes exported).
- questionnaire-submission answer content (`MYC_MESG_QUESR_ANS` → HQA) not in this export.
</content>
