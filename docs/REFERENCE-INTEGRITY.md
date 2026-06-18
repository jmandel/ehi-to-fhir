# Reference Integrity

## Strategy: internal resolvability, not id-equality

We mint **synthetic FHIR ids**. Epic's opaque ids are not recoverable from the EHI export, so
"same id as Epic" is the wrong invariant. What MUST hold is that our own reference graph is
**internally sound**:

> Every `Reference.reference` resolves to a resource we actually emit, and points at a resource
> type the FHIR element allows.

All ids are minted through one shared minter (`../lib/ids`, e.g. `id.practitioner(SER_ID)`,
`id.encounter(CSN)`, `id.location(DEPARTMENT_ID)`) keyed on the **natural key from the EHI row**.
A reference built with any other key (a login, a name string, a hand-rolled prefix) will dangle.
Resources are emitted by `src/<domain>.ts` via `../lib/gen` `emit()`; regenerate with
`bun build.ts`.

The checker `tools/refcheck.ts` validates this from `out/` alone (no target, no id matching):
it walks every resource, collects every `{reference}` edge, and reports **DANGLING** (referent not
emitted) and **TYPE VIOLATIONS** (referent type not allowed by the element). It also runs the
**NAKED-DISPLAY** census described below. `bun build.ts` runs it as a standing, non-fatal gate
and prints one loud line: `REFERENCE INTEGRITY: OK` or
`REFERENCE INTEGRITY: N dangling / M type-violations / K naked-display`.

## The Specificity Principle (verbatim)

> Prefer the most specific REAL entity the EHI supports, emitted as a RESOLVABLE reference, over
> (a) omitting because it doesn't match the target's string, or (b) hardcoding the target's value
> (especially a corporate-brand display). Faithful + specific + resolvable beats "matches Epic's
> display." Do NOT chase the answer key's exact display strings; emit the truer, finer-grained
> referent from the EHI.

### Why the worklist is derived from the target's reference census (not a named list)

The principle is only as good as its coverage. A hand-picked list of "known" naked displays
(Immunization.location brand, DiagnosticReport.performer) catches today's cases and silently
misses tomorrow's. So the worklist is generated **mechanically**: enumerate every
reference-bearing element across the entire target (`fhir-target/*.json`), then classify the
corresponding element in our output. Every element where the target carries a `.display` (a
human label) but no resolvable `.reference` becomes a candidate the principle must adjudicate —
emit a finer real entity, or record a justified residual.

To make this **enforceable going forward** (so it can't regress as generators change),
`refcheck.ts` now ships a **NAKED-DISPLAY check** that runs on every build. It isolates
Reference-shaped nodes from CodeableConcept `coding[]` entries (which also carry `.display`) by
requiring the node to NOT look like a Coding (no `.code`/`.system` sibling) and to NOT sit at a
`.coding` path tail. Any new naked-display reference element raises the count and surfaces in the
gate line — the principle is now applied across the board, automatically, not just on named cases.

## Before / after

| | dangling | type-violations | naked-display (reference elements) |
|---|---|---|---|
| Round 1 | 34 | 0 | (named only) |
| Round 2 | 0 | 0 | (broadening census) |
| Round 3 | 0 | 0 | 96 candidates triaged |
| Pre-cleanup | 0 | 0 | 142 (incl. 46 `Observation.basedOn` logical refs) |
| Post-cleanup | 0 | 0 | 96 (all deliberate residuals) |
| **Round 2b** | **0** | **0** | **96** (Binary `attachment.url` edges now resolved by the gate) |

Final build: `bun build.ts` → **685 resources** (baseline) / **763** with `--embed-attachments`
(adds the 78 `Binary` resources); `bun tools/refcheck.ts` → **0 DANGLING, 0 TYPE VIOLATIONS**
(exit 0) on every variant; all references resolvable; **96** naked-display reference-element
instances across 7 paths, every one a justified residual (see RESIDUAL). The naked-display count
is unchanged by round 2b — `attachment.url` is a `Binary/<id>` *string*, not a naked
display-only `Reference`, so it never counted toward (and does not change) the 96.

**Cleanup — `Observation.basedOn` is now a RESOLVABLE ServiceRequest reference (not a naked
display).** The order-placer link was previously the single largest naked-display residual (46
instances: `identifier`+`display` with no literal reference). The cleanup added a
`ServiceRequest` generator (`src/servicerequest.ts`, 9 resources, minted `sr-<ORDER_PROC_ID>`),
so the lab/order placer is now materialized as a real resource and `Observation.basedOn` /
`DiagnosticReport.basedOn` carry a resolvable `reference` (e.g. `ServiceRequest/sr-439060606`)
that still preserves the original order `identifier` and `display`. That removed all 46 from the
census, dropping it **142 → 96**. (Note: the reference RESOLVES within our bundle, but it does
NOT byte-match the target, whose `basedOn` points at an opaque `ServiceRequest/emwK…` the
reference export never emitted as a resource — so the `.reference` leaf classifies `unsure` in
the compare ledger while the `.display` leaf is now EXACT where the order name byte-matches.)

The final NAKED-DISPLAY census (now 96; `Observation.basedOn` is gone — see cleanup note above):

```
  39  DocumentReference.custodian    ::  UnityPoint Health
  24  Communication.sender           ::  DANNINGER, GAYLA J | MYCHART, GENERIC ...
  14  Observation.performer          ::  MYCHART, GENERIC | FARGEN, MEGAN
   9  Specimen.collection.collector  ::  CORNELL,VIRA X | WATKINS,MICHELLE ...
   8  MedicationRequest.recorder     ::  EPIC, USER
   1  Patient.contact.organization   ::  OTHER
   1  Immunization.manufacturer      ::  GLAXO SMITH KLINE
```

### Per-class fixes applied

- **A — mint-consistency (referrer used the wrong id key):** none outstanding. All referrers
  mint via `../lib/ids` with the correct natural key; verified by 0 dangling. (Historically the
  class that drove the round-1 → round-2 collapse from 34 → 0.)
- **B — referent-emission (owner generator omitted a real referent):** none outstanding. Every
  referent is emitted by its owning generator; verified by 0 dangling.
- **C — drops (unbackable / spurious references):** none required. No reference had to be dropped
  to reach 0 dangling; the residual naked-displays are NOT dangling references — they carry no
  `.reference` at all, so they never violated integrity.
- **D — specificity (naked display → resolvable finer entity):** the two named cases plus the
  Encounter.account case are wired as resolvable references to the most specific real EHI entity:
  - `Immunization.location` → `Location/loc-1700801002` "MAC APL INTERNAL MEDICINE" on all 14
    IMM_CSN-bearing rows, via `IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID`. The 5 null-location rows
    genuinely lack an IMM_CSN (no department) → correct omit. (Replaces the brand
    `{display:"UnityPoint Health"}`.)
  - `DiagnosticReport.performer` → resolvable lab entities: `Practitioner/prac-802011`,
    `Practitioner/prac-144590`, and the lab `Organization/org-LLB-359`,
    `Organization/org-LLB-1700801005` — the real performing lab, not a brand org.
  - `Encounter.account` → `Account/acct-376684810` "MANDEL,JOSHUA C" (a resolvable Account, not a
    naked name).

  All remaining naked-display candidates were adjudicated against the EHI and found to offer no
  finer REAL entity with a stable, emittable natural key (see RESIDUAL) — so D was applied
  wherever the EHI supported it, and only there.

## Coverage table — every reference-bearing element in the target

Status legend: **resolvable** = we emit a resolvable `.reference`; **fixed-to-specific (D)** = was
a naked display / brand in the target, now a resolvable reference to a finer real entity;
**brand-residual** = deliberately left as a display-only brand/system label (no finer real
entity); **logical-residual** = display(+identifier) logical reference to an entity we do not
materialize as a resource; **dropped (C)** = reference removed as unbackable. Every reference
element below resolves unless explicitly marked residual.

| resourceType.path | status |
|---|---|
| Observation.subject / .encounter | resolvable (Patient / Encounter) |
| Observation.performer | resolvable when EMP→single PROV_ID; else **brand-residual** (system users) |
| Observation.specimen / .hasMember / .derivedFrom | resolvable |
| Observation.basedOn / DiagnosticReport.basedOn | **resolvable** (ServiceRequest/sr-<ORDER_PROC_ID>; preserves order identifier+display) — was logical-residual before the cleanup |
| DiagnosticReport.subject / .encounter / .result | resolvable |
| DiagnosticReport.performer | **fixed-to-specific (D)** (real lab Practitioner/Organization) |
| Encounter.subject / .participant.individual / .location.location | resolvable |
| Encounter.account | **fixed-to-specific (D)** (resolvable Account) |
| Condition.subject / .encounter / .evidence.detail | resolvable |
| AllergyIntolerance.patient | resolvable |
| Immunization.patient / .encounter / .performer.actor | resolvable |
| Immunization.location | **fixed-to-specific (D)** (administering department Location) |
| Immunization.manufacturer | **brand-residual** (MFG `_C_NAME` code-list label, not a real Org) |
| MedicationRequest.subject / .encounter / .medicationReference / .requester / .priorPrescription | resolvable |
| MedicationRequest.recorder | resolvable when EMP→single PROV_ID; else **brand-residual** ("EPIC, USER") |
| Communication.subject / .encounter / .recipient / .inResponseTo / .about | resolvable |
| Communication.sender | resolvable (Patient) or **brand-residual** (care-team/system users not in CLARITY_SER) |
| Specimen.subject | resolvable |
| Specimen.collection.collector | **brand-residual** (COLLECTOR_IDN free-text; no stable staff key) |
| DocumentReference.subject / .author / .authenticator / .context.encounter / .extension…valueReference | resolvable |
| DocumentReference.custodian | **brand-residual** ("UnityPoint Health"; no resolvable custodian Org) |
| Patient.generalPractitioner / .managingOrganization | resolvable |
| Patient.contact.organization | **brand-residual** (literal "OTHER" relationship code, not an Org) |
| Account.subject / .owner / .coverage.coverage / .guarantor.party | resolvable |
| Coverage.subscriber / .beneficiary / .payor | resolvable |
| Claim.patient / .insurer / .provider / .facility / .careTeam.provider / .insurance.coverage / .item.locationReference / .item.encounter | resolvable |
| ExplanationOfBenefit.patient / .insurer / .provider / .careTeam.provider / .insurance.coverage / .item.encounter | resolvable |
| CoverageEligibilityResponse.patient / .insurer / .insurance.coverage (+contained) | resolvable |
| Invoice.subject / .issuer / .account / .participant.actor | resolvable |
| ChargeItem.subject / .context / .performer.actor / .performingOrganization / .costCenter / .account | resolvable |
| PaymentReconciliation.paymentIssuer | resolvable |
| CarePlan.subject / .addresses / .goal | resolvable |
| Goal.subject / .expressedBy | resolvable |

## Residual

All residuals below carry **no `.reference`** (so they are NOT dangling and do not break
integrity) — they are display-only because the EHI offers nothing finer with a stable, emittable
natural key. Counts are reference-element instances from the NAKED-DISPLAY census.

| element | count | reason the EHI offers nothing finer |
|---|---|---|
| `DocumentReference.custodian` | 39 | `CLARITY_SA.EXTERNAL_NAME` brand "UnityPoint Health" (SERV_AREA_ID 10) is emitted only as a Location place, not an Organization. The custodian `identifier` (Care-Everywhere org id) is a documented export GAP. The only org-level facility we emit (`org-18` MAC ASSOCIATED PHYSICIANS LLP) is the **billing** facility, a different entity — wiring it would be semantically wrong, not finer-true. |
| `Communication.sender` | 24 | Care-team / system users (DANNINGER GAYLA J, FARGEN MEGAN, MYCHART GENERIC, AMBULATORY ADMIN, …) are not in `CLARITY_SER`, so there is no PROV_ID to mint `id.practitioner` from. Already display-only. |
| `Observation.performer` | 14 | Same class as above (FARGEN MEGAN, MYCHART GENERIC) — not in `CLARITY_SER`. |
| `Specimen.collection.collector` | 9 | `ORDER_PROC_2.COLLECTOR_IDN` is free text; `COLLECTOR_USER_ID` is NULL for every collector. A fuzzy `COLLECTOR_IDN = CLARITY_EMP.NAME` join resolves only 2 of 5 distinct names; the rest fail on comma/space formatting — no stable key, partial + unreliable. |
| `MedicationRequest.recorder` | 8 | "EPIC, USER" generic system user (USER_ID 1), not in `CLARITY_SER`. The generator already mints a Practitioner ref when the EMP recorder resolves to a single PROV_ID; otherwise display-only. |
| `Patient.contact.organization` | 1 | Literal relationship/category code "OTHER", not a real organization. |
| `Immunization.manufacturer` | 1 | `IMMUNE.MFG_C_NAME` "GLAXO SMITH KLINE" is a category code-list label (`_C_NAME`), not a real Organization row; emitting an Org would fabricate an entity. |

No dangling references, no type violations, and no dropped (class C) references remain. The
naked-display gate is wired into `build.ts` and will flag any future regression.

## Note — `Binary` and `attachment.url` (now covered by the gate, round 2b)

`DocumentReference.content[].attachment.url` is a **string** (`Binary/<id>`), not a `Reference`,
so a plain `Reference.reference` walk would miss it. As of round 2b `refcheck.ts`'s `walk()`
treats any `url` string matching `^Binary/` as a real reference **edge** and resolves it against
the emitted `Binary` resources, so the link is covered by the standing gate rather than being
silently invisible. Verified with a negative test: mangling one `Binary` id makes the gate report
`1 dangling  DocumentReference/… .content.attachment.url -> Binary/<id>`. `refcheck.ts` also now
honors `OUT_DIR` (like `compare/classify.ts`) so the gate runs against `out-answerkey/` too.

- The opt-in `--embed-attachments` pass (`src/binary.ts`) now materializes **78 `Binary`
  resources** (`out/Binary.json`, content-addressed `bin-<sha1>` ids) and `src/documentreference.ts`
  points `attachment.url` at `Binary/<our-hashid>` (+ `size`/`hash`/`title`). `Binary` is in the
  resolvable set, so under `bun build.ts --embed-attachments` all 78 `attachment.url` edges
  resolve: **0 DANGLING / 0 TYPE VIOLATIONS / 96 naked-display** (identical to baseline).
- Baseline (`bun build.ts`, no flag) emits no `Binary` and **no `attachment.url`** — the lean
  build carries the attachment metadata (`contentType`/`size`/`hash`/`title`/`creation`/`format`)
  but omits the `url` so it never points at a `Binary` it isn't carrying. (`build.ts` propagates
  `EMBED_ATTACHMENTS` to the generator subprocesses; `documentreference.ts` gates the `url` on it.
  This closed a regression where the lean build emitted 78 `attachment.url`s with no `Binary` →
  78 dangling, which the build's own gate flagged.) So baseline has nothing to dangle either.
- The target's `attachment.url = Binary/<opaque-Epic-id>` (e.g. `Binary/eYZ.h-kKFRO…`) is **not
  byte-reproducible** — Epic's opaque server-assigned Binary id is not in the EHI. We mint our own
  stable content-hash id instead. The candidate
  `tolerate-documentreference-content-attachment-binary` rule stays **DROPPED/never-applied**
  (the two urls genuinely differ — blessing them equal would be a false equivalence), so the 56
  `attachment.url` + 28 `attachment.contentType` target elements remain a **genuine GAP floor**,
  not a tolerance. The Binary work's value is in-bundle self-containedness + gate coverage, not a
  ledger flip on the url.
