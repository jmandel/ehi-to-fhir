# careplan domain — gaps (CarePlan, CareTeam, Goal)

Counts: Goal 1/1 · CarePlan 1/4 · CareTeam 0/1.

Every absence below records the EXACT search that proves it (so the claim is falsifiable,
not asserted). Re-run any of them to re-confirm. Whole-export search gate:
`bun tools/find-concept.ts "<term>" [--grep '<regex>']`, then confirm with `bun lib/q.ts`.

## Goal (1/1 — shape-complete)

- **`category[].coding` (code/system/display) — coding gap (confirmed-absent).** Target codes
  `4` / `urn:oid:…737184.20005` / "Blood Pressure". The export ships only the resolved label
  `PT_GOALS_INFO.AMB_GOAL_TYPE_C_NAME = "Blood Pressure"`. **Searched:**
  `PRAGMA table_info('PT_GOALS_INFO')` → no bare `AMB_GOAL_TYPE_C` column, only the
  `_C_NAME` label (general-patterns §23: Epic strips the numeric `_C` and ships only the
  resolved name); `SELECT name FROM sqlite_master WHERE name LIKE 'ZC_%'` → empty (no
  category-decode tables shipped). The numeric Epic category code is therefore unrecoverable.
  Emitted `category[].text` only.
- **`description.text` wording — faithful-source note (NOT a gap).** Target renders
  "Blood Pressure below 140/90"; the source
  `PT_GOALS_UPDATES.DISPLAY_NAME_OT = "Blood Pressure < 140/90"` (verified by query) carries
  the literal "<" — Epic substitutes "<"→"below" only in its rendered FHIR view. **We keep the
  literal source text** rather than fabricate the substitution; the datum is fully present.

## CarePlan (1/4)

### Generated — the longitudinal "Plan for Patient Care" (intent=plan)
Reconstructed from the active problem list + goal + upcoming appointment. Residual gaps:

- **`category[1].coding` "Longitudinal" (SNOMED 38717003) — coding gap (confirmed-absent).**
  Epic-assigned SNOMED. **Searched:** value scan `grep -rlw '38717003' raw/EHITables/` →
  zero files (i.e. `find-concept --grep '\b38717003\b'` finds no source). Emitted
  `category[].text = "Longitudinal"` only. (`category[0]` assess-plan is a fixed US-Core label
  and is reproduced in full.)
- **`activity[].detail.scheduledPeriod` UTC offset + `end` — data gap (start clock-time IS
  recoverable and is emitted).** The appointment is `PAT_ENC` CSN 1183640405, Scheduled,
  6/16/2027. The **start clock-time is in the export**:
  `PAT_ENC_APPT.PROV_START_TIME = "6/16/2027 2:30:00 PM"` ("the date and time the appointment
  is scheduled to begin with this provider"). We LEFT JOIN `PAT_ENC_APPT` and emit
  `scheduledPeriod.start` from `PROV_START_TIME` (local wall-clock; date-only here because no
  timezone offset ships — see below), falling back to the midnight calendar date
  (`EFFECTIVE_DATE_DTTM`/`CONTACT_DATE`) only when `PROV_START_TIME` is null. What remains
  unrecoverable:
  1. **UTC timezone offset** — the target renders `19:30Z` (= 2:30 PM Central, UTC−5), but
     no offset column ships. **Searched:** `find-concept "time zone"` / `"utc"` surfaces no
     populated offset column tied to this encounter. FHIR `dateTime` requires an offset when a
     time is present, so rather than assert a possibly-wrong Central offset we emit the date.
  2. **`end` / duration** — there is no appointment-length column in the export. **Searched:**
     `find-concept "appointment length"` / `"duration"` / `"end time"` → the only length
     columns (`DENTAL_VISIT_INFO.VISIT_APPT_LENGTH`, `TPL_SCHED_VST_LEN`) are documented but
     not shipped; `ORDER_PROC_4.SCHED_DUR`/`APPT_WINDOW_*_TIME` are order-scheduling fields,
     not tied to this scheduled office visit; `PRAGMA table_info('PAT_ENC_APPT')` shows only
     `PROV_START_TIME` (besides keys), no end/length/min/dur column. `end` is omitted.
- **`text` / `text.div` (generated narrative) — presentation gap (confirmed-absent).** The
  target carries an Epic-rendered XHTML summary (problems/goals/appointments table). The
  underlying data is all reproduced as structured fields. **Searched:** `find-concept
  "narrative"` surfaces only `ORDER_NARRATIVE` (procedure narratives, unrelated). The rendered
  HTML is an Epic display artifact stored in no column; not byte-reproducible. (This is the
  dom-6 best-practice warning the validator reports — acceptable.)

### NOT (yet) generated — the 3 "Patient Instructions" CarePlans (intent=proposal, Encounter Level)
- **Whole resources — RECOVERABLE-AS-NARRATIVE (the defining `note[].text` IS in the export —
  in the NOTE CORPUS, not in any TSV).** Each is defined by free-text patient instructions
  carried in `note[].text` (the encounter Patient-Instructions). **The defining text survives
  verbatim in the linked clinical-note corpus** (`raw/Rich Text/*.RTF`), which the earlier
  search did not scan:
  - CSN 948004323 → NOTE_ID **3820384431** (`HNO_3820384431_*.RTF`, type "Patient
    Instructions"): *"1. For post-concussive syndrome: …a medication like topiramate for
    headaches; other options would be amitriptyline… 2. For blood pressure:"*
  - CSN 974614965 → NOTE_ID **4024965334** (`HNO_4024965334_*.RTF`): *"1. Start with 10 mg of
    nortriptylene at night 2. Can increase to 20 mg at night after 1-2 weeks (allow your system
    to get used to it)"*
  - CSN 958148810 → NOTE_ID **4216859306** (`HNO_4216859306_*.RTF`): *"1. Nortriptyline taper:
    10 mg once a night for 2 weeks. Then can go to 10 mg every other night."*

  **Re-verify:** `bun tools/find-concept.ts --grep 'topiramate' --notes` (and `'every other
  night'`, `'allow your system to get used'`) — each maps the matching RTF back to its
  HNO_INFO NOTE_ID / type "Patient Instructions" / CSN. The instruction text is extracted with
  `lib/rtf2txt.ts` (HNO_INFO → RTF joined by NOTE_ID = the 2nd `_`-token of the filename).
  - **Why the prior verdict was wrong (NOTE-CORPUS blind spot):** the earlier scan covered only
    `raw/EHITables/*.tsv`. There, the documented *structured* source `DISCRETE_PAT_INSTRUCTIONS`
    (and `DISCRETE_PAT_INSTR_CMT/_EDIT`, `OR_CASE_PAT_INST`, `PAT_ADDL_INSTR_EPT`) is
    "documented but EMPTY/not-shipped", and a TSV-only value scan for the distinctive phrases /
    "topiramate"/"amitriptyline" returned ZERO hits — so the content was wrongly called absent.
    The phrases were never in a TSV because they live in the note bodies. The TSV nortriptyline
    hits (`CLARITY_MEDICATION`/`ORDER_MED*`/`RX_MED_TWO`/`MYC_MESG_RTF_TEXT`) are medication-order
    **names**, not the instruction text — but the actual instruction text IS recoverable, from
    the notes.
  - **Build status:** the 3 CarePlans are reconstructable as `note[].text` (or `text.div`) from
    the rtf2txt-extracted note body; this is recoverable-as-narrative, NOT fabrication. The only
    residual is the structured/discrete *shape* of `DISCRETE_PAT_INSTRUCTIONS` (unshipped) and
    Epic's exact XHTML render — both approximatable/tolerable, not blockers.
  **Lossy proxy (NOT needed now that the notes are the source):** `ORDER_MED_SIG.SIG_TEXT`
  (ORDER_ID 772179266) = "Take 1 (one) capsule by mouth nightly. Start with 10 mg at night; can
  increase to 20 mg after 1-2 weeks if no side effects" — a differently-worded **Rx sig** that
  overlaps ONE note semantically; prefer the verbatim note text over this proxy.
- **`encounter.*` — FIELD-LEVEL false-absence, but MOOT (no parent to attach to).** The 3
  referenced encounters DO exist:
  `SELECT PAT_ENC_CSN_ID,CONTACT_DATE,APPT_STATUS_C_NAME FROM PAT_ENC WHERE PAT_ENC_CSN_ID IN
  ('948004323','974614965','958148810')` → all three return (948004323 8/29/2022 Completed;
  958148810 3/2/2023; 974614965 12/1/2022). So `encounter.reference` / `identifier`
  (value = `PAT_ENC_CSN_ID`, system = the CSN OID) / `display` are all derivable from
  `PAT_ENC` — and these Encounters already render in the Encounter domain. **And now that the
  defining `note[].text` is known to survive in the note corpus** (see above), the encounter
  linkage is no longer moot: each parent CarePlan IS constructible (HNO_INFO joins the note to
  its CSN, which gives the encounter), so the encounter fields would attach to a real,
  buildable CarePlan. (The earlier "recoverable-but-moot" framing assumed the note text was
  absent; with the notes as source, both the parent and its `encounter.*` are recoverable.)

## CareTeam (0/1 — not reconstructable: roster master not shipped)

- **Whole resource — data gap (confirmed-absent).** The target is one longitudinal care team
  (LOINC `LA28865-6`) with 3 participants (Everton 133057, Rammelkamp 144590, Kommer 554368)
  and per-member specialty/PCP-type roles. The roster master that defines this grouping —
  `EPT_CARE_TEAMS` (the "Provider Care Team" master, keyed by `CARE_TEAMS_ID`) — is **not
  shipped**. **Searched:**
  - `SELECT name FROM sqlite_master WHERE name LIKE '%CARE_TEAM%'` → empty
    (`find-concept "care team"` lists `EPT_CARE_TEAMS.CARE_TEAMS_ID` under
    "documented but EMPTY/not-shipped"; `PAT_ENC_2.PRIMARY_TEAM_ID` has zero non-null values).
  - `PAT_PCP` (queried) lists only the CURRENT PCP Rammelkamp (144590, TERM_DATE null) and the
    TERMED prior PCP Dhillon (802011, termed 8/28/2022) — Dhillon is NOT in the target, and
    Everton/Kommer are absent from `PAT_PCP`. So `PAT_PCP` cannot produce the target roster.
  - `TREATMENT_TEAM` (queried) is per-encounter (CSN-keyed `TR_TEAM_ID`, e.g. 144590 as
    "Consulting Physician" on individual visits), not a longitudinal roster.
  - The three SER ids resolve individually in `CLARITY_SER` (Everton 133057, Rammelkamp
    144590, Kommer 554368) but co-occur only in `CLARITY_SER`/`ARPB_TRANSACTIONS`/
    `HSP_ACCT_OTHR_PROV`/`PAT_ENC` — billing/encounter contexts, not a team grouping.
  Assembling a roster from these unrelated rows would invent the membership relationship, so
  the resource is omitted.

- **JUDGMENT CALL — emit a PAT_PCP-derived CareTeam instead of nothing? DECISION: NO (leave it
  unbuilt).** *(Blessed-value call, Claude Opus 4.8, 2026-06-17, at the maintainer's request.)*
  The question posed: PAT_PCP carries REAL care-team/PCP-relationship data — would emitting a
  CareTeam built from it (with a DIFFERENT membership than the target's documented roster) be
  more faithful than emitting nothing? Weighed both ways:
  - **For (build it):** the PCP relationship is genuine, shipped clinical data; both PCP
    providers (Rammelkamp 144590, Dhillon 802011) are already emitted as Practitioners; PAT_PCP
    even carries per-member effective/term dates and a specialty label, so a structurally-valid
    minimal CareTeam is mechanically constructible.
  - **Against (the decision):** (1) **Resource-semantic mismatch** — `PAT_PCP` is the patient's
    *PCP-designation history* (one current + one termed PCP), NOT a care-team roster; the target
    CareTeam is the distinct Epic "Provider Care Team" concept (`EPT_CARE_TEAMS`). Reshaping PCP
    history into a `CareTeam` asserts a team-membership grouping the source does not record — the
    very "invent the membership relationship" failure flagged above, only from a different table.
    (2) **The membership would be wrong, not merely different** — a PAT_PCP CareTeam would include
    **Dhillon**, the *former* PCP (termed 8/28/2022), who is explicitly NOT in the documented
    3-member roster (Everton / Rammelkamp / Kommer); only Rammelkamp overlaps, and Everton +
    Kommer are unreachable from PAT_PCP. So it would assert a termed prior PCP as a care-team
    member while omitting 2 real members. (3) **Faithfulness governs** — the honest home for the
    real PCP datum is the PCP relationship itself (e.g. `Patient.generalPractitioner`), not a
    CareTeam whose roster PAT_PCP does not define. Misrepresenting *what* the data is (PCP history
    vs a team) and *who* the team is outweighs the value of populating the 0/1 slot.
  - **Outcome:** CareTeam stays unbuilt (`emit("CareTeam", [])`). The 3-member roster is NOT
    fabricated, and no PAT_PCP-as-CareTeam surrogate is emitted. Should `Patient.generalPractitioner`
    later be wired from PAT_PCP, that is the faithful place for this datum.
- **`participant[].role[].coding` — coding gap (partial; MOOT given roster absent).** Even with
  a roster, the role codes (specialty `17` / `urn:oid:…836982.1050`, PCP-type `1` /
  `urn:oid:…698084.5655`, SNOMED `410534003` "Not indicated") are Epic-assigned with no source:
  no `ZC_` tables, no bare `_C` columns on `PAT_PCP` (`PRAGMA table_info` → none). Only the
  `_C_NAME` text labels survive (`PAT_PCP.SPECIALTY_C_NAME="Internal Medicine"`,
  `PCP_TYPE_C_NAME="General"`), so `role[].text` would be reproducible for the PCP member — but
  this is moot because the team roster itself is absent.
- **`category` LOINC `LA28865-6` — coding gap (confirmed-absent; MOOT).** **Searched:**
  `grep -rl 'LA28865' raw/EHITables/` → zero files. Epic-assigned; ships in no table, and no
  text-label source exists either.
