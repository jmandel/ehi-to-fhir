/**
 * content.ts — ALL reader-facing prose for the report, hand-authored for a FHIR DevDays audience
 * that knows FHIR cold but has never seen Epic's internal database and doesn't know any term this
 * project invented. The machine data (counts, examples, per-field diffs) lives in
 * report/viewer/data.json; THIS file is the words that explain it in plain language.
 *
 * Keys deliberately match the categories emitted in data.json so the UI can look up the right
 * explanation: equivalenceFamilies[delta.kind] and couldntFamilies[delta.family].
 *
 * Authoring rule (non-negotiable): an internal id or a code value is NEVER an explanation. We say
 * "they point to the same patient", not "same PAT_ID Z7004242".
 */

export type Family = {
  title: string;        // friendly headline
  short: string;        // one-line gloss for badges/tooltips
  what: string;         // what actually differs / is missing, in FHIR-reader terms
  why: string;          // why it's equivalent (tolerated) OR why it can't be reproduced (gap)
  soWhat: string;       // consumer impact / what we do instead
  example?: string;     // a concrete, real example (no internal ids)
  guardOrProof: string; // the discipline: anti-drift guard (equiv) or falsifiable proof (gap)
};

export const content = {
  // ---------------------------------------------------------------------------
  meta: {
    title: "Rebuilding Epic's FHIR from a raw patient download",
    tagline:
      "How much of a hospital's clean FHIR API can you reconstruct from the messy “download everything” export the patient is legally entitled to?",
    premise: [
      "A US patient can get their Epic record two ways. One is a developer-friendly **FHIR API** — tidy, coded, the thing you build apps against. The other is a **bulk export**: their legal right-of-access copy of *everything*, delivered as hundreds of near-raw database tables. The export is the source data *behind* the API, but in the raw — few standardized codes, lots of internal keys, and the human-readable labels without the codes that name them.",
      "We asked a concrete question: **starting from only the raw export, how faithfully can you rebuild the clean FHIR the API would have returned?** We wrote deterministic code to do the rebuild, then compared every single field of our output against Epic's *own* FHIR API output for the same patient — field by field, 16,120 of them.",
      "This report is the answer, resource by resource, with every difference explained: what came out identical, what came out different-but-equivalent (and why that's fine), and what genuinely could not be reproduced (and the proof of why).",
    ],
    whyCare:
      "That question is the gap between *the data you're entitled to* and *the data that's actually usable*. Where the export can be turned back into faithful FHIR, patient data is far more portable than it looks. Where it can't, this is a concrete, evidence-backed list of exactly what right-of-access loses — and why.",
    specimen:
      "Everything here is one real patient record — the report author's own Epic data, published with consent — run through the pipeline and scored against the matching Epic FHIR API capture (~590 export tables in, FHIR out). One family member's name and phone number have been removed.",
  },

  // ---------------------------------------------------------------------------
  // S1 — the two views
  twoViews: {
    heading: "Two views of the same record",
    export: {
      title: "The raw export (what we start from)",
      points: [
        "Hundreds of database tables dumped almost exactly as Epic stores them internally.",
        "Categorical values arrive as **a label with no code** — you get the word “Married” or “Office Visit”, but not the coded value behind it.",
        "Standardized terminology (LOINC, SNOMED, RxNorm…) is mostly **absent** — Epic assigns it on its servers, and that step isn't in the download.",
        "IDs are Epic's internal keys, not the opaque IDs the FHIR API hands out.",
      ],
    },
    api: {
      title: "The FHIR API (what we're trying to match)",
      points: [
        "Clean R4 resources: Patient, Condition, Observation, MedicationRequest…",
        "Coded concepts with systems and codes, ready to compute on.",
        "References that resolve to other resources by opaque server IDs.",
        "Server-added niceties: human-readable narrative, display labels, version stamps.",
      ],
    },
    answerKey:
      "We treat Epic's FHIR API output as an **answer key** — the ground truth we measure against. We never copy from it; we only score against it. (Where our deterministically-derived value is the *truthful* one and Epic's is a server reformatting, we keep ours — more on that below.)",
  },

  // ---------------------------------------------------------------------------
  // S2 — the three buckets (de-jargoned names)
  buckets: {
    heading: "How we score every field",
    intro:
      "We compared all 16,120 fields Epic's API returned and put each into one of three buckets. The buckets are defined so that “we matched it” can never be faked, and “we couldn't” always carries evidence.",
    identical: {
      key: "identical",
      name: "Identical",
      color: "#1a7f37",
      def: "Byte-for-byte the same value Epic's API returned.",
      internalName: "EXACT",
    },
    equivalent: {
      key: "equivalent",
      name: "Equivalent",
      color: "#bf8700",
      def: "Looks different on the surface, but provably means the same thing — and we say exactly why, every time.",
      internalName: "TOLERATED",
      discipline:
        "An “Equivalent” verdict is earned by an automated check that re-derives the equivalence from the data and would still flag a *real* error. It is never “ignore this field.” For example, two references count as equivalent only after we confirm both IDs denote the same real-world entity; a reference pointing somewhere else still shows up as a difference.",
    },
    couldnt: {
      key: "couldnt",
      name: "Couldn't reproduce",
      color: "#c2410c",
      def: "Genuinely not derivable from the raw export — shown with the evidence of what we searched.",
      internalName: "GAP",
      discipline:
        "A “Couldn't reproduce” verdict is earned by searching the *whole* export — not just the obvious table — and showing it came up empty. Early on we repeatedly declared things missing that were actually sitting in another table (a billing code hiding in the claims data, marital status in a claims table). So the rule became: prove absence across the entire export, including the free-text notes, before claiming it.",
    },
    headline:
      "Identical + Equivalent = **faithfully reconstructed**. For this record that's 88% (12,562 identical + 1,703 equivalent). The remaining 12% (1,855 fields) couldn't be reproduced — every one with a documented reason, grouped into a handful of root causes below.",
  },

  // S0b — what the raw export gives you vs. what the terminology bridge adds (hero decomposition)
  bridgeContribution: {
    heading: "How much of this is the raw export — and how much is the terminology bridge?",
    intro:
      "“Identical” above is flattering, because a lot of it is only identical thanks to a step we added. The raw export ships most coded concepts as **text without a code** (a diagnosis name, not its SNOMED code). We reconstructed a **terminology bridge** — a lookup from Epic's internal codes to standard ones (RxNorm, CVX, ICD, NDF-RT…), keyed entirely on the export's own data — and layered it on. Splitting the result shows how much each part contributes:",
    buckets: [
      { key: "exportIdentical", label: "Identical from the raw export", color: "#1a7f37", note: "byte-for-byte, no help needed" },
      { key: "exportEquivalent", label: "Equivalent (form only)", color: "#bf8700", note: "same meaning, different form" },
      { key: "bridge", label: "Recovered by terminology mapping", color: "#0e7490", note: "standard codes the bridge rebuilt from the export's own keys" },
      { key: "couldnt", label: "Couldn't reproduce", color: "#c2410c", note: "not in the raw data, even with the bridge" },
    ],
    takeaway:
      "So from the **raw export alone**, about **59%** comes out identical-or-equivalent. The terminology bridge recovers **another ~30%** of Epic's standard codes — nearly a third of the whole record's fidelity rests on that one reconstructed lookup. Of the rest, a small slice (~1.6%) is a **deliberately different value** we emit instead of mimicking Epic, and ~10% is genuinely **blank** — couldn't reproduce. (You can see this field-by-field in the comparison tool's “raw export only” toggle.)",
  },

  // Families for the "Different value" group (we emitted something, just not byte-identical / not auto-verified)
  differentFamilies: {
    "we-chose-a-truthful-value": {
      title: "We emitted the source-faithful value",
      short: "We produced the export's real value, which differs from Epic's rendering.",
      what: "Epic's API renders the field one way; the export holds another, and we emit the export's. Sometimes ours is *more* complete (Epic masked a clinician to “Z”; the export has “Zoe”); sometimes it's just a different form (“36 S Brooks St” vs “Street”, the literal order text vs a tidied catalog string).",
      why: "A core rule of the project is faithfulness over mimicry: never copy Epic's output, always derive from the source. Reproducing Epic's exact string would mean fabricating it.",
      soWhat: "We **did** produce a value — this is a deliberate difference, not a loss. A consumer gets a correct, source-traceable value; it just isn't byte-identical to Epic's.",
      example: "Medication name: ours “NORTRIPTYLINE HCL 10 MG PO CAPS” (the actual order text) vs Epic “nortriptyline 10 MG capsule”.",
      guardOrProof: "Each value is derived from a specific export column; this is a documented stance, not a miss.",
    },
    "different-reference": {
      title: "A reference to the same thing, different id",
      short: "Points at the same entity, but we couldn't prove the 1:1 match to bless it equivalent.",
      what: "We reference the same real-world entity, but through our id scheme, and the data didn't give a clean one-to-one match to verify they're the same — so it shows as a difference rather than an “equivalent reference”.",
      why: "When the mapping isn't provably unique, we refuse to assert equivalence (that would risk silently linking the wrong thing).",
      soWhat: "Our reference resolves correctly within our own bundle; it just isn't auto-verified identical to Epic's.",
      example: "an ordering provider where several look-alikes prevent a unique match.",
      guardOrProof: "Fail-closed: no unique natural key ⇒ not blessed as equivalent.",
    },
    "different-precision": {
      title: "A coarser or finer timestamp",
      short: "Faithful source timestamp that differs from Epic's by seconds (or is date-only).",
      what: "We emit the timestamp the export actually recorded, which differs from Epic's published instant by a few seconds, or is date-only where Epic has a full datetime.",
      why: "The export's column was written by a different process than Epic's published value; we won't fabricate the missing precision.",
      soWhat: "Correct to within seconds/the day; just not byte-identical.",
      example: "a report finalize time: ours from the export vs Epic's, ~10 seconds apart.",
      guardOrProof: "The only candidate column differs by non-rounding seconds, so we keep ours rather than guess.",
    },
  } as Record<string, Family>,

  // What's missing ENTIRELY — whole categories absent from this export
  missingEntirely: {
    heading: "What's missing entirely",
    intro:
      "Beyond field-by-field gaps, a few **whole categories of data simply aren't in this export** — so the resources Epic builds from them can't be reconstructed at all. These are export-configuration set-asides, not failures of our code, and we verified each by searching the whole export. The notable ones:",
    items: [
      { title: "Physical-exam “SmartData” findings", count: "118 Observations", detail: "Epic's SmartForm/SmartTool findings — structured physical-exam results like “no focal deficit.” The data store that backs every one of them isn't included in this export, so none can be rebuilt. (They're set aside from both sides of the scorecard so they don't distort the comparison.) Their clinical content largely survives as free-text in the linked visit notes — lost as structured data, mostly preserved as narrative.", proof: "Searching the whole export for the SmartData store and its element codes returns nothing." },
      { title: "Panel & group structure", count: "~75 Observations", detail: "Epic emits “grouper” resources — a Vital Signs panel that ties blood pressure, weight, and height together (via member links), and survey/score totals. The export stores each individual measurement flat, with no row for the panel or header — so the grouping resources and their member links can't be reconstructed. The individual measurements themselves are all present.", proof: "The member measurements exist in the export; no parent/panel row does." },
      { title: "Care teams & care-plan templates", count: "CareTeam + 3 CarePlans", detail: "Care-team rosters and Epic's care-plan templates/narratives live in stores this export doesn't ship; the patient-instruction text survives inside the notes.", proof: "Whole-export search for the care-team and care-plan-template stores is empty." },
      { title: "Server-only documents", count: "21 DocumentReferences", detail: "Some documents in Epic's API are pure server-side metadata pointers — the document id and its body aren't in the export, so there's nothing to point at.", proof: "The note id is absent from the export's note tables and no file ships for it." },
    ],
    note: "Everything here is genuinely absent from the patient's own download — the kind of gap right-of-access can't currently close, regardless of how good the translation code is.",
  },

  // ---------------------------------------------------------------------------
  // S5a — equivalence families. KEYED BY data.json delta.kind
  equivalenceFamilies: {
    "isomorphic-ref": {
      title: "Different IDs, same connections",
      short: "References use different IDs but resolve to the same entity.",
      what:
        "Epic's resource IDs are opaque server tokens (think `Patient/eVZ4r…`); ours are derived from the export's own keys (`Patient/pat-Z7004242`). So a reference like `subject` or `performer` doesn't match Epic's string-for-string.",
      why:
        "FHIR resource IDs are arbitrary handles — a bundle is correct as long as every reference resolves to the right resource *within it*. Both reference graphs have the identical shape: this observation's subject is the one and only patient; that visit's performer is the same physician. We confirm the two IDs denote the same real person/provider/encounter by a stable natural key (the patient's medical-record number, the provider's Epic ID, the visit's contact number) before calling them equivalent.",
      soWhat:
        "None for any client that follows references instead of comparing ID strings — which is every correct FHIR client.",
      example:
        "subject: Epic `Patient/eVZ4rX…` vs ours `Patient/pat-Z7004242` — both are the same patient.",
      guardOrProof:
        "Fail-closed: if a natural key isn't unique (e.g. one accession number maps to three identical specimens) the check refuses to call it equivalent, and a reference re-pointed at the wrong resource is reported as a real difference. Backed by a build gate that confirms zero references dangle.",
    },
    "cosmetic-display": {
      title: "Same thing, reformatted text",
      short: "Display/label text reformatted (case, name order) but the same content.",
      what:
        "A human-readable label or display string is formatted differently. Epic title-cases and reorders; the export stores it raw. “TRANSFER OF CARE” vs “Transfer Of Care”; “YOUNG, JESS” vs “Jess Y”.",
      why:
        "These are display strings attached to a code or a reference that already match. The underlying meaning — the code, the entity being named — is identical; only the human formatting differs. We keep the source-of-truth text from the export.",
      soWhat:
        "Cosmetic. The machine-readable part (the code, the reference) is unchanged; only the label a human reads is styled differently.",
      example: "reason for visit: Epic “Transfer Of Care” vs ours “TRANSFER OF CARE” — identical code underneath.",
      guardOrProof:
        "The check is case- and name-form-aware only. Any change to the actual *content* — a different surname, a different concept — is reported as a real difference, not waved through.",
    },
    "minute-rounded-instant": {
      title: "Timestamps rounded to the minute",
      short: "Our source timestamp is minute-precise; the target's extra seconds match the rounding.",
      what:
        "Some timestamps in the export are recorded only to the minute, while Epic's API shows seconds. So our `…T21:09:00Z` vs Epic's `…T21:09:37Z`.",
      why:
        "We tolerate this only when Epic's value equals ours once rounded to the minute — i.e. the difference is genuinely just the seconds the export never recorded.",
      soWhat:
        "Sub-minute precision only; the event is pinned to the correct minute.",
      example: "an observation issued time: ours `21:09:00Z`, Epic `21:09:37Z`.",
      guardOrProof:
        "Crucially, when a timestamp differs by seconds in a way that *isn't* rounding (e.g. a report's finalize time is off by 7–26 seconds with non-zero seconds on both sides), we do NOT call it equivalent — it stays in the “couldn't reproduce” bucket.",
    },
    "standard-vs-proprietary-code": {
      title: "We used the standard code where Epic used its own",
      short: "Encounter class: standard v3-ActCode vs Epic's proprietary code.",
      what:
        "The encounter `class` field has an *extensible* binding to FHIR's standard value set (ambulatory, inpatient, …) — meaning you should use a standard code when a suitable one fits. Epic returns its own proprietary code (`HOV`, `Appointment`); we emit the standard `AMB` (ambulatory).",
      why:
        "Both are valid FHIR — Epic's proprietary code is permitted (the official validator flags it as a *warning*, not an error, since the binding is extensible). But because a suitable standard code clearly applies here, the standard one is the more conformant choice, so we emit it, derived from the encounter's recorded patient class.",
      soWhat:
        "A generic FHIR client gets a code from the value set it expects. Epic's value isn't wrong, just Epic-specific; ours is the portable equivalent.",
      example: "encounter class: ours `AMB` (standard ambulatory) vs Epic's proprietary `HOV`.",
      guardOrProof:
        "We re-derive the standard code from the encounter's own recorded patient class; a wrong class would mismatch and be reported as a difference.",
    },
    "structural-variant": {
      title: "Same content, a different valid shape",
      short: "Attachments and a few values represented in a different but equivalent form.",
      what:
        "The same information is carried in a different valid structure. The biggest case: note/attachment bytes. Epic points an attachment at `Binary/<opaque-server-id>`; we ship the actual bytes and point at a `Binary/` whose ID is the content's own fingerprint, so the bundle is self-contained. Also small cases like a US state spelled out vs abbreviated.",
      why:
        "The payload is the same; only the representation differs. For attachments we verify our reference's fingerprint matches the declared hash of the bytes in that slot, so we know it's the right content.",
      soWhat:
        "A client gets the same attachment content — in fact ours is resolvable within the bundle, where Epic's points outside it.",
      example: "an attachment: Epic `Binary/eY9…` (bytes not in the export) vs ours `Binary/bin-<sha1>` (the actual note bytes).",
      guardOrProof:
        "Swapping in a different note's bytes would change the fingerprint and be caught. (Note: we deliberately do NOT claim our attachment *URL* equals Epic's — that stays a real difference, since the IDs genuinely differ.)",
    },
    "server-version-stamp": {
      title: "A version stamp Epic's server adds",
      short: "Status codes carry a value-set version we don't echo.",
      what:
        "On a few status fields Epic's server stamps the version of the value set it used (e.g. `version: \"4.0.0\"` on an allergy's clinical-status code). We emit the same status code without the version stamp.",
      why:
        "The code itself matches exactly; only the server-applied version annotation is absent. That annotation is a server bookkeeping detail, not patient data.",
      soWhat: "None — the status and its code are identical.",
      example: "clinical status “active” — identical code; Epic adds `version 4.0.0`, we don't.",
      guardOrProof: "Only the `version` sub-field is waved through; the status code must still match exactly.",
    },
    "blessed-value": {
      title: "A reviewed judgment call",
      short: "A human-reviewed equivalence that pins both exact values.",
      what:
        "A small number of differences are judgment calls a reviewer explicitly signed off on, recording *both* exact values so any future change resurfaces.",
      why:
        "Some equivalences can't be machine-derived but are clearly correct on inspection; rather than ignore the field, we pin both values and require sign-off.",
      soWhat: "Negligible in volume; included for completeness and auditability.",
      example: "a privacy-masked provider display the reviewer accepted as the intended value.",
      guardOrProof:
        "Pinning both values means any drift on either side immediately re-opens the difference for review.",
    },
  } as Record<string, Family>,

  // ---------------------------------------------------------------------------
  // S5b — couldn't-reproduce families. KEYED BY data.json delta.family
  couldntFamilies: {
    "withheld-dictionary": {
      title: "Epic's internal lookup tables aren't in the download",
      short: "Codes whose meaning lives in Epic's server-side dictionaries, not the export.",
      what:
        "Lots of coded fields — the *type* of visit (“Office Visit”, “Telephone”), where a patient was admitted from, the role a clinician played in signing a note — are coded against Epic's internal dictionaries. The export ships the human label (sometimes) but not the code, and never the dictionary that defines it.",
      why:
        "The translation from Epic's internal concept to a code lives in master files on Epic's servers that the patient download simply doesn't include. We searched the whole export for these code systems; the candidate columns are absent or empty.",
      soWhat:
        "We keep whatever human-readable label the export does carry (and emit it as text), and omit the code rather than invent one.",
      example: "a visit's type: Epic shows code “Office Visit” in a coded field; the export has no visit-type code at all.",
      guardOrProof:
        "Whole-export search for each of these code systems returns nothing; the numeric code columns that would hold them are not shipped.",
    },
    "no-code-crosswalk": {
      title: "The words survive, the standardized codes don't",
      short: "Diagnosis/result wording is kept; the LOINC/SNOMED code is gone.",
      what:
        "Epic's API returns coded concepts — a diagnosis with a SNOMED code, a lab with a LOINC code. The export ships the human-readable *name* but, for many of these, no column linking that name to a standard code.",
      why:
        "That name→code mapping is computed on Epic's servers from master files the download doesn't contain. For diagnoses, for instance, the export gives the diagnosis wording but no SNOMED code and no table pairing the two.",
      soWhat:
        "We emit the concept as `text` (faithful) and omit the code rather than guess. Importantly, where a standard code *can* be recovered (we built a terminology bridge for drugs, vaccines, allergens, and billed procedures), it is — that bridge lifted coded coverage from ~10% to ~71%. What's left here is the part with no recoverable code.",
      example: "a medication-indication diagnosis: Epic carries the SNOMED code; the export keeps only the diagnosis text.",
      guardOrProof:
        "We searched for any table pairing the internal concept with a standard code; for these concepts the candidate tables are present but empty.",
    },
    "not-in-export": {
      title: "The field simply wasn't exported",
      short: "A column the API populates is absent or blank in the download.",
      what:
        "Some fields the API fills have no corresponding data in the export at all — for example the *end* time of an appointment (the export records only the start), or an “accident-related?” flag.",
      why:
        "These are export-configuration set-asides: the information lives in Epic but wasn't included in this download. We confirmed the candidate columns are absent or 100% empty across the export.",
      soWhat:
        "We omit the field rather than fabricate it. (A blank beats an invention.)",
      example: "an appointment's `period.end` — the export stores the start time only.",
      guardOrProof:
        "Every candidate column for these fields was checked and found absent or entirely empty.",
    },
    "structural-grouper": {
      title: "Grouping rows the flat export doesn't have",
      short: "Panel/flowsheet “container” resources with no standalone source row.",
      what:
        "Epic's API sometimes emits a grouping resource — a panel header that gathers its member results, or a flowsheet container. The export stores the individual measurements flat, with no separate row for the group.",
      why:
        "The grouper is a structure Epic's server composes at publish time; there's no underlying record in the export to rebuild it from.",
      soWhat:
        "The individual results are all present and faithful; what's missing is the extra wrapper resource that would group them.",
      example: "a survey/vitals group resource that exists in the API but has no standalone row in the export.",
      guardOrProof:
        "Whole-export search finds the member measurements but no parent/grouper record.",
    },
    "we-chose-a-truthful-value": {
      title: "We kept the truthful value on purpose",
      short: "The export's real value differs from Epic's server rendering — we keep the real one.",
      what:
        "Sometimes the export's true value differs cosmetically from what Epic's API renders, and we deliberately emit the truthful one. The patient's real legal name “Joshua” where the API shows the nickname “Josh”; the specific clinic name where the API shows the rolled-up health-system brand; the exact drug description on the order versus a tidied catalog string.",
      why:
        "A core rule of the project is faithfulness over mimicry: never copy the answer key, always derive from the source. Matching Epic's rendering here would mean fabricating it.",
      soWhat:
        "These count as differences only because the comparison demands byte-identity. Semantically ours is correct — often *more* correct. This is the one bucket we're proud to leave “unmatched.”",
      example: "patient name: ours “Mandel, Joshua C” (the real name) vs Epic's “Mandel, Josh C”.",
      guardOrProof:
        "Each value is derived from a specific export column; this is a documented design stance, not a miss.",
    },
    "unmatchable-reference": {
      title: "A reference we can't safely prove points to the same thing",
      short: "Opaque target references we can't uniquely match back to an export entity.",
      what:
        "A handful of references point at entities that are opaque in Epic's output and can't be uniquely tied back to a single export record — so unlike the “different IDs, same connections” case, we can't *prove* they're the same.",
      why:
        "When the mapping isn't a clean one-to-one, we refuse to assert equivalence (that would risk silently linking the wrong thing).",
      soWhat:
        "We emit our best faithful reference/value, but don't claim it matches Epic's — honesty over a flattering score.",
      example: "an ordering-provider reference where the export can't disambiguate which of several identical-looking providers Epic meant.",
      guardOrProof:
        "Same fail-closed rule as the equivalent-references check: no unique natural key ⇒ we don't bless it.",
    },
    "server-decoration": {
      title: "Things Epic's server adds at publish time",
      short: "Narrative, server flags, and curation decisions made outside the data.",
      what:
        "FHIR servers decorate resources with things that aren't patient data: human-readable narrative blocks, a “user selected this code” boolean, a provider “active?” flag, and curation choices about which records to surface.",
      why:
        "These are generated by Epic's FHIR server at publish time and have no antecedent in the export — there's no column that records “was this code user-selected?”.",
      soWhat:
        "We omit them. They're presentation/bookkeeping, not clinical content.",
      example: "a code's `userSelected: true` flag, or a generated narrative summary — neither exists in the export.",
      guardOrProof:
        "Searching the export for a source column (provider status, user-selected flag, etc.) returns nothing.",
    },
    "redacted-or-masked": {
      title: "Deliberately redacted personal information",
      short: "Present in the source, withheld by our policy.",
      what:
        "A small set of fields — phone number, street address, medical-record-number value — are present in the export but emitted as `[REDACTED]` tokens in this published report.",
      why:
        "This is a privacy choice, not a capability gap. The data is recoverable; we choose not to publish it.",
      soWhat:
        "Counts as a difference, but it's intentional and reversible by policy.",
      example: "a phone number: Epic shows the real number; we show `[REDACTED-PHONE]`.",
      guardOrProof: "Documented redaction policy — the only family here that's a deliberate withholding rather than a limit of the data.",
    },
    "not-byte-reproducible": {
      title: "A timestamp we can't reproduce to the exact second",
      short: "The only source timestamp differs from the target by non-rounding seconds.",
      what:
        "For a few timestamps, the only column the export carries differs from Epic's value by several seconds in a way that isn't simple rounding (both sides have non-zero seconds).",
      why:
        "Epic's published instant was set by a different server process than the one timestamp the export records, so we can't reproduce the exact second without fabricating it.",
      soWhat:
        "We emit the faithful source timestamp; it's correct to within seconds but not byte-identical.",
      example: "a report's finalize time: ours from the export vs Epic's, 7–26 seconds apart.",
      guardOrProof:
        "We confirmed the only candidate column differs by non-zero seconds (rounding ruled out), so it's held here rather than called equivalent.",
    },
    "comparison-artifact": {
      title: "An artifact of how the answer key is shaped",
      short: "The target duplicates a resource in a way our cleaner model doesn't.",
      what:
        "In a couple of places Epic's API emits the same entity multiple times (e.g. a provider repeated once per role), where our model emits it once.",
      why:
        "This is an artifact of the answer key's shape, not missing data — our single, de-duplicated resource carries the same information.",
      soWhat: "No information lost; the count differs because we don't duplicate.",
      example: "a provider that appears several times in Epic's output vs once in ours.",
      guardOrProof: "The duplicated instances carry no information our single resource lacks.",
    },
  } as Record<string, Family>,

  // ---------------------------------------------------------------------------
  // S6 — EHI-only resources (the upside twist)
  newResources: {
    heading: "What Epic's FHIR API never included",
    intro:
      "Here's the twist: in places the raw export contains *more* than the curated API. The patient-access FHIR API is essentially the clinical chart plus insurance coverage. But the export also ships the full billing, claims, remittance, and secure-messaging machinery — none of which the API exposes. So we built valid FHIR for it, with no answer key to compare against; correctness here rests on the official HL7 validator (zero errors) and adversarial review of every mapping.",
    groups: [
      {
        name: "Secure messages",
        types: ["Communication"],
        blurb:
          "116 real MyChart messages between the patient and their care team — subjects, bodies, send times, threading, even medication-renewal requests — reconstructed from the in-basket message store. Epic's FHIR API doesn't expose these as Communication resources at all.",
      },
      {
        name: "Billing & insurance",
        types: ["ExplanationOfBenefit", "Claim", "ChargeItem", "Invoice", "Account", "PaymentReconciliation", "CoverageEligibilityResponse"],
        blurb:
          "The complete financial story the clinical API drops: every billed charge line, the as-submitted insurance claims (with real procedure and diagnosis codes from the claim image), the insurer's adjudication math (allowed/paid/deductible/copay, reconciled to the penny), the remittance, the guarantor account, and the plan's benefit/cost-share matrix.",
      },
      {
        name: "Supporting resources",
        types: ["ServiceRequest", "Binary"],
        blurb:
          "The lab orders that results point back to (recovered from the export's own order keys so the order→result links resolve), and the actual note/attachment bytes shipped inline so the bundle is self-contained.",
      },
    ],
    qa:
      "Without an answer key, correctness was held to: the official HL7 FHIR R4 validator passing with zero errors; every reference resolving inside the bundle; the financial arithmetic reconciling (e.g. an explanation-of-benefit's submitted total equals eligible plus non-covered, and payments tie out to the penny); and adversarial review that caught and corrected real mistakes (an unsound diagnosis-code join downgraded to text; a mis-identified identifier system replaced).",
  },

  // ---------------------------------------------------------------------------
  // S7 — method (kept light, collapsible)
  method: {
    heading: "How it was built (and how we kept ourselves honest)",
    intro:
      "The tidy pipeline below is the result, not the path. Almost every rule here was learned by being wrong first — usually caught by a pointed question — and then turned into an automated gate so the same mistake couldn't recur quietly.",
    stories: [
      {
        title: "“It's not in the export” was wrong four times",
        body:
          "Our first instinct was to trust the obvious column: if it's blank, the data isn't there. It usually was — one join away, often in a table from a completely different domain. Procedure codes turned up in the *claims* service lines; marital status in a *claims* table; physical-exam findings and even patient instructions were sitting verbatim in the free-text note files. The rule that came out of it: search the *whole* export — including the unstructured notes — before ever declaring something absent.",
      },
      {
        title: "We got caught copying the answer key",
        body:
          "An early version hardcoded the patient's name straight from Epic's output. That's cheating — and it hid the truth, because the export's *real* name is “Joshua,” not the nickname “Josh” the API shows. That incident created the hard rule: always derive from the source, never copy the target — and keep the truthful value even when it differs.",
      },
      {
        title: "Scoring turned out to be the subtle part",
        body:
          "Once we deliberately diverged from Epic in good ways — truthful names, specific clinics, self-consistent IDs — a naive “does it match?” score punished our *best* output. So we built a disciplined three-bucket comparison where “equivalent” is always backed by a check that would still catch a real error, and never means “ignore this field.”",
      },
      {
        title: "Validating the whole bundle caught what per-field checks missed",
        body:
          "Per-resource checks were green while a real bug hid: every encounter date was silently month/day-swapped, visible only when the day exceeded 12. Only validating the assembled bundle with the official validator surfaced it.",
      },
    ],
    recovered:
      "The payoff of searching hard: a terminology bridge rebuilt the standard codes for drugs, vaccines, allergens, and billed procedures (coded coverage 10% → 71%); a public NPI registry filled in provider credentials; and the order→result links were recovered from the export's own order keys. Each “it can't be done” that got pushed on usually turned out to be doable.",
  },

  // ---------------------------------------------------------------------------
  // S8 — honest residual
  residual: {
    heading: "What's genuinely lost",
    intro: "With the terminology bridge on, the irreducible 12% is, in priority order:",
    points: [
      {
        title: "Terminology Epic assigns on its servers, with no home in the export (the largest share)",
        body:
          "The proprietary code catalogs — visit types, flowsheet codes, note-signing roles, plan codes — plus the SNOMED codes on diagnoses. The export ships the label, never the code, and these have no standard equivalent the bridge could anchor to. We keep the text and omit the code. Genuinely lost without fabrication.",
      },
      {
        title: "Server decorations and un-shipped stores",
        body:
          "Generated narrative, server flags and version stamps, server-resolved display labels, and whole stores left out of this particular download — dominated by the physical-exam “flowsheet” store. Lost as structure, but its clinical content largely survives as note narrative.",
      },
      {
        title: "A few computed links and exact-second timestamps",
        body:
          "Some cross-links the export has no key for, and second-level timestamps where the only available column differs from Epic's by non-rounding seconds. Plus the truthful divergences we're proud of (the real name, the specific clinic) — lost only to byte-identity, not to meaning.",
      },
      {
        title: "Intentionally redacted personal information",
        body: "Present in the source; withheld by our publishing policy. Not a capability gap.",
      },
    ],
    bottomLine:
      "The residual is small not because the first pass was good, but because each “it can't be done” was forced to prove itself — and most didn't survive. What remains is overwhelmingly terminology Epic mints server-side with no antecedent in the patient's own data, plus our deliberate choice to stay faithful to the source rather than mimic Epic's rendering.",
  },

  // ---------------------------------------------------------------------------
  glossary: [
    { term: "EHI export", def: "“Electronic Health Information” export — the bulk, near-raw copy of a patient's whole record (hundreds of database tables) that US right-of-access rules entitle them to. Our starting point." },
    { term: "FHIR API (patient access)", def: "The clean, coded FHIR resources an EHR like Epic serves to apps. Our target / answer key." },
    { term: "Answer key", def: "Epic's own FHIR API output for this patient, used only to score our reconstruction against — never copied from." },
    { term: "Identical", def: "Our field is byte-for-byte the same as Epic's API. (Internally: EXACT.)" },
    { term: "Equivalent", def: "Our field differs on the surface but provably means the same thing, with a stated reason and an automated check. (Internally: TOLERATED.)" },
    { term: "Couldn't reproduce", def: "The field genuinely isn't derivable from the export, shown with proof of what was searched. (Internally: GAP / “floor”.)" },
    { term: "Faithful reconstruction", def: "Identical + Equivalent together — the share of Epic's FHIR we rebuilt correctly from the raw export." },
    { term: "Natural key", def: "A stable real-world identifier (a medical-record number, a provider ID, a visit number) we use to prove two differently-IDed resources are the same entity." },
    { term: "Reference graph", def: "How resources point at each other. We rebuild a graph with the same shape as Epic's even though the IDs differ." },
    { term: "Terminology bridge / crosswalk", def: "A lookup we reconstructed that restores standard codes (drugs, vaccines, allergens, billed procedures) where the export had a recoverable key — lifting coded coverage from ~10% to ~71%." },
    { term: "Label without a code", def: "The export's habit of giving a human-readable category name (“Married”, “Office Visit”) but not the coded value behind it." },
    { term: "Faithfulness over mimicry", def: "The project's core rule: emit the truthful value derived from the source, even when it differs from Epic's server rendering — never copy the answer key." },
    { term: "Floor / proof-carrying", def: "A “couldn't reproduce” that has been proven irreducible (searched-and-absent, not-anchorable, or infeasible) rather than merely unattempted." },
  ],
};

export type Content = typeof content;
