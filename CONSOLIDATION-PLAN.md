# Consolidation Plan — EHI→FHIR central-lib refactor

**Scope.** Merge the 11 proposed central-lib modules + 34 do-not-merge flags from the six
concern surveys into one reviewed blueprint, and make that blueprint **subsume** the
portability fix order in `AUDIT-PORTABILITY.md` §7. Every duplicate is verified against the
real files (`lib/db.ts`, `lib/ids.ts`, `lib/gen.ts`, `src/*.ts`) before being scheduled.

**Two correctness postures, never blurred:**
- **Pure move** (DRY only) — output for the CURRENT patient must stay **byte-identical**.
  Proof: re-run the build + `compare/classify.ts` and diff `out/`.
- **Behavior-unifying** (timezone, allergy fix, table guards) — output **changes by design**;
  the intended diffs are enumerated per step. These are the portability fixes.

The two **PATIENT-SPECIFIC** anchors from the audit (`PATIENT_PAT_ID`, `COVERAGE_ID`,
audit §3) are **derive-from-export** edits, NOT deduplication. They are folded into the
sequence (Step 0) because they gate same-org reuse and the plan claims to subsume audit §7,
but they are out of scope for the "merge duplicates" surveys.

---

## 1. Target lib architecture (final, deduped)

The six surveys proposed the same handful of modules under different headings (three propose
`EPIC_INSTANCE_OID`, three propose `nn`, three propose a time helper). The merged target is
**three extensions of existing modules + two new files**. No god-modules; the per-domain
`*_C_NAME`→code maps stay co-located with their generators (only the lookup *mechanism* is
shared).

### 1a. Extend `lib/ids.ts` — identity, OID composition, system registries, encounterRef

The audit's "centralize the `.283` OID" (audit §4a, fix #3) lives here because every src file
already imports `../lib/ids`, so no new import wiring.

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `PATIENT_PAT_ID` (change) | `export const PATIENT_PAT_ID = process.env.EHI_PAT_ID ?? q1("SELECT PAT_ID FROM PATIENT LIMIT 1")?.PAT_ID` (guard 0 rows) | Derive the whole-pipeline patient anchor instead of baking `"Z7004242"`. | `lib/ids.ts:12` (current literal) |
| `EPIC_INSTANCE_OID` | `export const EPIC_INSTANCE_OID: string = process.env.EHI_INSTANCE_OID ?? "1.2.840.114350.1.13.283"` (bare, no `urn:oid:`) | Single source of the org-instance OID node `.283`; new org = one edit. | `src/patient.ts:56` `IHSMRN_OID` (strip `urn:oid:`) |
| `epicOid` | `epicOid(suffix: string): string` → `urn:oid:${EPIC_INSTANCE_OID}.${suffix}`; `epicOid("")` → bare root urn | Compose any Epic-instance `identifier.system`/`code.system`. | `src/patient.ts:58` `MRN_OID_BASE` pattern |
| `epicOidRaw` | `epicOidRaw(suffix: string): string` → `${EPIC_INSTANCE_OID}.${suffix}` (no urn prefix) | Bare-OID form for OIDs interpolated into identifier **values**, not systems. | `src/documentreference.ts:73` `NOTE_OID_TAIL` (used at :393 as `${tail}_${noteId}`) |
| `SYS` (Epic-instance registry) | `export const SYS = { CSN: epicOid("2.7.3.698084.8"), PLACER: epicOid("2.7.2.798268"), HSP_ACCT: epicOid("2.7.2.726582"), ETR: epicOid("2.7.2.726582.1"), FLO: epicOid("2.7.2.707679"), SDI: epicOid("2.7.2.727688"), DRUG: epicOid("2.7.2.698288"), FORM: epicOid("2.7.2.698288.310"), NOTE: epicOid("2.7.2.727879"), ... } as const` | Named registry for the **recurring** cross-referenced Epic systems so basedOn/encounter-linked resources cite byte-identical systems via one symbol. Single-use OIDs may stay inline as `epicOid(suffix)`. | `src/encounter.ts:48` `SYS_CSN` (.698084.8); `src/lab.ts:48` `SYS_PLACER` (.798268) |
| `STD` (standard URIs) | `export const STD = { LOINC, SNOMED, UCUM, RXNORM, ICD10CM, NDC, NPI, CPT, OBS_CATEGORY, V2_0203 } as const` | Standard (non-Epic) system URIs that recur. **Org-independent** — must NOT be composed from `EPIC_INSTANCE_OID`. Optional/low-priority. | `src/lab.ts:53-61` (LOINC/SNOMED/UCUM/v2 block) |
| `encounterRef` | `encounterRef(csn: string\|number\|undefined): {reference, identifier} \| undefined` | The recurring `Encounter/<id>` + CSN-identifier reference; folds in `SYS.CSN`. Co-located with `id.encounter`. | `src/obs-vitals.ts:188-192` |

**Audit cross-ref:** closes audit §1 Blocker A (`PATIENT_PAT_ID`), audit §4a / fix #3 (the
49-literal `.283` OID), and removes the basedOn-link drift hazard (audit §4a footnote).

### 1b. Extend `lib/db.ts` — guarded reads (table-safety) + `naiveLocal`

Audit fix #5 ("add `tableHasRows()`/`columnsOf()` guards"). `db.ts` already exports
`q`/`q1`/`tableHasRows`/`columnsOf`/`dateRealToISO`/`parseEpicDateTime` (`lib/db.ts:16-70`),
so the guards belong here, not in a new file.

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `qIf` | `qIf<T>(table: string, sql: string, ...params): T[]` | Run query only if `table` exists+has rows (via `tableHasRows`), else `[]` — turns a thinner table subset into false-absence instead of a hard crash. | `lib/db.ts:16` `q` + `:26` `tableHasRows`; guard model `src/obs-smartdata.ts:64` |
| `tablesPresent` | `tablesPresent(...tables: string[]): boolean` | True only if EVERY named table exists+has rows (the multi-table precondition). | `src/obs-smartdata.ts:64` (`!tableHasRows(A) \|\| !tableHasRows(B)`) |
| `hasColumn` | `hasColumn(table: string, col: string): boolean` | True if `table` materializes `col`; wraps `columnsOf`+memoized Set. | `src/location-org.ts:236` (`columnsOf("ORDER_PROC").includes("RESULT_LAB_ID")`) |
| `colSet` | `colSet(table: string): Set<string>` | Memoized column Set (PRAGMA once) for generators probing many columns of one table. | `src/obs-smartdata.ts:72-73` (`new Set(columnsOf(...))`) |
| `naiveLocal` | `naiveLocal(v: unknown): string \| undefined` | Epic textual datetime → naive `YYYY-MM-DDTHH:MM:SS` only when it carries a time (`includes("T")`), else undefined. The shared front-half `lib/time.ts` and `lab.ts` re-derive. | `src/lab.ts:90-93` `naive()` |

`dateRealToISO` already lives at `lib/db.ts:41` — `obs-social.ts:81 dateRealIso()` just
**imports** it (no new API).

**Audit cross-ref:** closes audit fix #5 (table guards) for the 7 unguarded generators.

### 1c. New `lib/time.ts` — the one timezone/datetime module

Warranted as a new file: timezone is a self-contained concern with org-config + DST/UTC
semantics that does not belong in `db.ts`'s handle layer or `ids.ts`'s identity layer. Built
**on** `lib/db.ts:parseEpicDateTime` (which stays zone-agnostic, per do-not-merge) and
`naiveLocal`. This is audit fix #4 ("centralize the timezone").

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `EHI_TZ` | `export const EHI_TZ = process.env.EHI_TZ ?? "America/Chicago"` | Single configured org timezone; cross-org = one env edit. | audit §4b / `AUDIT-PORTABILITY.md:192` (no constant exists today) |
| `isoDate` | `isoDate(v: unknown): string \| undefined` | Date-only `YYYY-MM-DD` from an Epic textual datetime. Collapses the 9 `isoDate`/`dateOnly` copies + ~6 inline idioms. | `src/servicerequest.ts:43-47` (most defensive — keeps full string if no `T`); body == `src/patient.ts:113`, `allergy.ts:35` |
| `utcFromUtcColumn` | `utcFromUtcColumn(v: unknown): string \| undefined` | Read a genuine `*_UTC_DTTM` column (already UTC wall-clock) and stamp `Z`. **No offset math** — the truly org-independent path. | `src/lab.ts:95-98` `utc()` (== `medication.ts:152` `utcInstant()`) |
| `localToUtcInstant` | `localToUtcInstant(localVal: unknown, opts?: { utcSibling?: unknown; tz?: string }): string \| undefined` | THE central wall-clock→UTC converter. **Prefers `opts.utcSibling`** (the paired `*_UTC_DTTM` value): derives the exact per-record offset from the local↔UTC pair (lab's BEST approach). Else converts naive local via `tz=EHI_TZ` using a real-tz routine. Naive+`Z` only as last resort. Replaces all 5 hand-rolled Central+DST routines AND allergy's fixed-Eastern. | `src/lab.ts:105-119` `localToUtc()`+`orderOffsetMs()` (offset-from-pair, preserve) fused with `src/encounter.ts:62-93` `chicagoToISO`/`chicagoOffsetHours` (naive-local DST fallback shape) |
| `localMidnightToUtcInstant` | `localMidnightToUtcInstant(isoDate: string, tz?: string): string \| undefined` | `YYYY-MM-DD` local-midnight (`tz=EHI_TZ`) → UTC instant — the social-history `issued` snapshot semantics, kept distinct on purpose. | `src/obs-social.ts:52-78` `centralMidnightToUtc()` |

**Audit cross-ref:** closes audit §1 Blocker B timezone (audit §4b, fix #4); fixes the
allergy summer-DST bug and the encounter-vs-allergy inconsistency.

### 1d. New `lib/cc.ts` — CodeableConcept / Identifier emit shapes

Pure emit-shaping, no DB/id concern; warranted as its own small file routed through
`gen.clean()`. (`encounterRef` deliberately lives in `ids.ts` next to `id.encounter`, not
here, because it needs `SYS.CSN`.)

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `cc` | `cc(system, code, display?, text?): {coding:[{system,code,display?}], text?}` | Universal single-coding CodeableConcept; `text` defaults to `display`; falsy fields dropped via `clean()`. | `src/obs-vitals.ts:174` (peers condition.ts:104, lab.ts:676, claim.ts:406, eob.ts:243) |
| `concept` | `concept(text: string\|null\|undefined): {text} \| undefined` | Text-only CC guarded on a possibly-empty label — dominant where the EHI ships no code. | `src/condition.ts:141-144` `codeFromDxName` |
| `category` | `category(...ccs: CodeableConcept[]): CodeableConcept[]` | Variadic `category[]` assembly so per-domain `CATEGORY_*` consts are `category(cc(...))`. **MUST be variadic** (encounter-dx is 2-element). | `src/obs-vitals.ts:172-177`; 2-elem case `src/condition.ts:116-137` |
| `ident` | `ident(system, value, opts?: {use?, type?}): Identifier \| undefined` | One Identifier `{use?,type?,system,value}`, undefined for empty value. | `src/encounter.ts:541` (peers medication.ts:574, immunization.ts:213) |

### 1e. New `lib/fmt.ts` — value/row-shape primitives

Pure formatting with no DB/id concern; the natural home for `nn`/`money`/`enumMap`/
`coalesceName`/`titleCaseName`. **`clean()` stays in `gen.ts`** (already centralized,
uniformly imported — no action). The surveys split on whether `nn` goes to `gen.ts` or a new
file; verdict: **new `lib/fmt.ts`**, since these are value helpers and lumping into `gen.ts`
(which is the emit-contract module) muddies its single responsibility.

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `nn` | `nn(v: unknown): string \| undefined` | Trim a DB TEXT value; undefined for null/empty-after-trim. The universal column normalizer. | `src/eob.ts:67` (10 byte-identical copies; eob/invoice/coverage are cleanest) |
| `money` | `money(v: unknown, opts?: {round?: boolean}): {value:number, currency:string} \| undefined` | FHIR Money(USD) from a textual amount; `opts.round` rounds to cents for **computed-number** callers (eob/claim sums). | `src/chargeitem.ts:69` (text variant) + `src/eob.ts:82` (`Math.round(n*100)/100` as the round path) |
| `enumMap` | `enumMap<V>(value: unknown, map: Record<string,V>): V \| undefined` | The shared `*_C_NAME`→code **lookup mechanism** with never-guess fallthrough: trims key, returns `map[key]` or undefined. **The map TABLES stay per-domain.** | `src/immunization.ts:99` (`STATUS_MAP[k] \|\| undefined`) |
| `coalesceName` | `coalesceName(...vals: unknown[]): string \| undefined` | First non-empty trimmed value — `nn(a) ?? nn(b) ?? ...` (EXTERNAL_NAME ?? SERV_AREA/DEPT/PROV_NAME). | `src/location-org.ts:88` |
| `titleCaseName` | `titleCaseName(s: string): string` | Title-case a whitespace-delimited token run (`w[0]+w.slice(1).toLowerCase()`) to humanize ALL-CAPS Epic names. | `lib/ids.ts:80` (`tc` closure in `patientDisplay`) |

### 1f. New `lib/providers.ts` — provider/party resolution

Warranted by cohesion + size (~9 helpers + 2 constant tables, copy-pasted across 8
generators; too large to bolt onto `ids.ts`). Consumes the centralized OID/ids and naturally
delivers the audit's provider table-guard.

| name | signature | purpose | canonical seed |
|---|---|---|---|
| `SENTINEL_SER_IDS` | `ReadonlySet<string>` `{"199995","3724611","E1011"}` | Non-person routing/lab CLARITY_SER pseudo-providers excluded from Practitioner emission. | `src/practitioner.ts:58` (verbatim copy at communication.ts:227) |
| `CARE_PROV_COLUMNS` | `ReadonlyArray<[string,string]>` | (table,column) provider-id columns denoting a clinical actor in a CARE context. | `src/practitioner.ts:61-72` (byte-identical at communication.ts:228-239) |
| `referencedProviderIds` | `(): Set<string>` | Distinct provider ids referenced in a care context, scanning `CARE_PROV_COLUMNS` with **per-table try/catch guard** (the portability table-guard). | `src/practitioner.ts:75-89` |
| `emittedPractitionerIds` | `(): Set<string>` | The exact set of minted Practitioner ids (referenced ∖ sentinels ∩ CLARITY_SER) — the single source of the selection rule, so cross-resource refs never dangle. | `src/practitioner.ts:332-355` (vs re-impl at communication.ts:223-259) |
| `isNonHumanResource` | `(provName): boolean` | True when a PROV_NAME denotes a lab/non-clinician resource (` LAB ` incl. "MAC LAB APL"). | `src/encounter.ts:422-423` (`/ LAB /.test(...)`) |
| `empLoginToSerId` | `(userId): string \| undefined` | Bridge CLARITY_EMP.USER_ID → CLARITY_SER.PROV_ID via **exact unambiguous** NAME=PROV_NAME join; undefined when zero/ambiguous (conservative false-absence). | `src/careplan.ts:77-86` (cleanest) |
| `empToSerMap` | `(): Map<string,string>` | Batch form of `empLoginToSerId` (GROUP BY USER_ID HAVING COUNT(*)=1) for hot loops. | `src/obs-vitals.ts:148-156` |
| `nameToSerId` | `(provName): string \| undefined` | Resolve a bare display NAME to a single PROV_ID when NAME maps to exactly one provider; else undefined. | `src/communication.ts:193-203` |
| `provName` | `(provId): string \| undefined` | CLARITY_SER.PROV_NAME for a PROV_ID (display lookup, nn-guarded). | `src/claim.ts:90-94` |
| `practitionerRef` | `(provId, display?): Reference \| undefined` | Typed `{reference, type:'Practitioner', display}`; undefined when provId falsy. | `src/documentreference.ts:116-121` + `src/careplan.ts:98-102` (merge) |
| `orgRef` | `(orgKey, display?): Reference \| undefined` | Organization ref via `id.organization()`; undefined when key falsy. **Caller passes the key incl. any prefix** (e.g. lab's `'LLB-'+id`). | `src/chargeitem.ts:186` |

**Audit cross-ref:** closes audit fix #8 (share SENTINELS/CARE_PROV_COLUMNS), and the
provider try/catch table-guard rides on `referencedProviderIds`.

---

## 2. Consolidation table

Risk legend: **L**=pure move, output unchanged · **M**=mostly move with a small behavioral
unification or many sites · **H**=intended output diffs (portability).

| helper(s) | call sites | files touched | risk | closes portability fix |
|---|---|---|---|---|
| `nn` (+ patient `ANY`) | ~241 (eob 20, claim 30, location-org 25, coverage 17, invoice 16, chargeitem 15, coverageeligibility 14, paymentrecon 13, communication 13, account 12, patient ANY 66) | 11 | **L** | — |
| `money` (round option) | ~25 (eob 6, coverageeligibility 8, claim 4, paymentrecon 3, invoice 2, chargeitem 2) | 6 | **L** | — |
| `enumMap` | ~10 | ~6 | **L** | — |
| `coalesceName` | ~5 | location-org, account, patient | **L** | — |
| `titleCaseName` | ~3 | ids, patient | **L** | — |
| `cc` / `concept` / `category` / `ident` | ~70 (83 coding + ~30 text-only + ~25 ident) | 20 | **L** | — (rides on `SYS.CSN`) |
| `encounterRef` | 6 (obs-vitals, lab, medication, obs-survey, servicerequest, documentreference) | 6 | **L** | indirectly via `SYS.CSN` |
| `EPIC_INSTANCE_OID`/`epicOid`/`epicOidRaw`/`SYS`/`STD` | ~49 literal decls → refs across 18 files; ~33 unique decl lines | 18 | **L** (move) → enables **H** at a new org | **.283 OID** (audit §4a, fix #3) |
| `PATIENT_PAT_ID` derive | 1 decl; ~36 `WHERE PAT_ID=?` consumers already import the symbol | ids.ts (+ defensive patient.ts:129) | **L** same-org / **H** new patient | **PATIENT_PAT_ID** (audit §1 Blocker A, fix #1) |
| `COVERAGE_ID` derive | 3 (coverageeligibility 67,115,270) | coverageeligibility | **M** | **COVERAGE_ID** (audit §3, fix #2) |
| `isoDate` | ~30 + ~6 inline | patient, condition, allergy, careplan, immunization, chargeitem, medication, eob, servicerequest, claim, coverageeligibility, paymentrecon, invoice, coverage | **L** | — |
| `utcFromUtcColumn` | 6 (lab 476,480; medication 347,410) | lab, medication | **L** | timezone (org-independent path) |
| `naiveLocal` | 2-3 | lab, time.ts internal | **L** | — |
| `dateRealToISO` (reuse) | 1 (obs-social:81) | obs-social | **L** | — |
| `localToUtcInstant` | ~13 (encounter 6, obs-vitals 2, obs-survey 2, obs-social 2, communication 1, allergy 1) | encounter, communication, obs-vitals, obs-survey, allergy | **H** | **timezone** (audit §4b, fix #4) |
| `localMidnightToUtcInstant` | 2 (obs-social 193,209) | obs-social | **H** | timezone |
| `qIf`/`tablesPresent`/`hasColumn`/`colSet` | ~10-14 new guards in 7 generators + 3 existing refactors | medication, lab, servicerequest, obs-vitals, obs-survey, encounter, condition, obs-smartdata, location-org | **M** | **table guards** (audit fix #5) |
| `SENTINEL_SER_IDS`/`CARE_PROV_COLUMNS`/`referencedProviderIds`/`emittedPractitionerIds` | 4 blocks, 2 files | practitioner, communication | **L** | provider table-guard (audit fix #8) |
| `empLoginToSerId`/`empToSerMap`/`nameToSerId` | EMP→SER 5 files | careplan, immunization, medication, obs-vitals, obs-survey | **M** (fixes obs-smartdata latent bug) | — |
| `provName` | 6 files | claim, encounter, eob, invoice, medication, immunization | **L** | — |
| `practitionerRef`/`orgRef` | practitionerRef 2; orgRef ~9 | documentreference, careplan + 9 org sites | **L** | — |

---

## 3. DO-NOT-MERGE register (intentional divergences the API must accommodate)

The 34 flags collapse to these standing constraints. Each names how the chosen API
**accommodates the BEST variant** rather than flattening it.

**Timezone**
1. **`lab.ts:105-119` per-order offset is the BEST variant — it is the SEED, not a deletion
   target.** Lab derives the exact UTC offset per order from the local↔`PRIORITIZED_INST_UTC_DTTM`
   pair (`orderOffsetMs`) and prefers the genuine UTC column outright (`utc()` at :95). It is
   org-INDEPENDENT. **Accommodation:** `localToUtcInstant(local, {utcSibling})` prefers the
   sibling and derives the offset from the pair; the fixed-`EHI_TZ` path is fallback only.
   Lab keeps passing its `*_UTC_DTTM` sibling — never flattened to a guessed Central offset.
2. **`medication.ts:347,410` reads a genuine `*_UTC_DTTM` column (already UTC).** Route
   through `utcFromUtcColumn()`, NOT `localToUtcInstant` — applying an offset would
   double-shift an already-UTC value.
3. **`obs-social.ts:73 centralMidnightToUtc` is calendar-day→local-midnight-instant**
   (summer→05:00Z, winter→06:00Z, pinned in comment). Kept as its own
   `localMidnightToUtcInstant` API; do NOT fold into the wall-clock converter.
4. **`allergy.ts:28-47` fixed Eastern `-5` no-DST is the WEAKEST/buggy variant.** On
   consolidation it routes through `localToUtcInstant` (tz-aware) — its `-5`-no-DST behavior
   is **fixed, not promoted**. This is an intended output diff (see Step 7).
5. **`communication.ts:79` returns a date-only string for date-only `CREATED_TIME`** (encounter
   returns undefined). Preserve by having communication's call site fall back to `isoDate()`
   for date-only input rather than dropping the value.
6. **`lib/db.ts:55-70 parseEpicDateTime` stays a FLOATING local datetime.** `lib/time.ts`
   builds ON it (`naiveLocal`/`isoDate` call it); folding tz into it would corrupt every
   date-only consumer.
7. **Date-only emitters (careplan, coverageeligibility, chargeitem, paymentrecon)** stay
   date-only. Their bodies consolidate into `isoDate()` but are NOT promoted to instant/tz
   conversion — that would fabricate precision the source lacks.

**OID / systems**
8. **`chargeitem.ts:59 OID_ETR = .726582.1` is a CHILD node**, not the HSP_ACCT `.726582`
   master. Distinct registry entry `SYS.ETR`; do not collapse into `SYS.HSP_ACCT`.
9. **`medication.ts:32 SYS_FORM = .698288.310` is a child of the drug OID `.698288`.** Both
   compose via `epicOid`, but stay two constants (`SYS.DRUG`, `SYS.FORM`).
10. **`documentreference.ts:73 NOTE_OID_TAIL` is the same node as `SYS_NOTE` but used as a
    BARE OID in an identifier VALUE.** Needs `epicOidRaw()` — a urn-prefixed merge corrupts
    the doc-id value.
11. **`paymentrecon.ts:71 OID_REMIT_IMAGE = .798268`** is numerically the placer OID but
    semantically the remittance-image record (not basedOn-linked). May point at `SYS.PLACER`
    but keep the distinct name/comment — if Epic splits the nodes it follows the remit master.
12. **`obs-vitals.ts:47 SYS_FLO .707679` vs `obs-smartdata.ts:59 SDI_OID .727688`** are
    distinct measure systems. Two registry entries (`SYS.FLO`, `SYS.SDI`); do not merge.
13. **`patient.ts:51` comment "stable, org-independent constants" is WRONG** — `.283` is the
    org-INSTANCE node. EPI/EXTERNAL/WPRINTERNAL/MRN MUST be centralized too; do not exempt
    them on the basis of that comment.

**Provider / party (conservative false-absence — the helpers return undefined; CALLERS choose policy)**
14. **`obs-survey.ts:233-240` emits display-only `{display: NAME}` on resolve-failure**;
    `obs-vitals.ts:201-203` DROPS the performer. Deliberately different policies —
    `empLoginToSerId`/`nameToSerId` return undefined and let each caller choose drop-vs-display.
15. **`communication.ts:212-220 carePartyRef`** mints a Practitioner ref only when the name
    maps to one SER AND that SER is in the emitted-Practitioner set. Keep the emitted-set
    gate; `nameToSerId` alone is insufficient (name→name across a foreign id-space).
16. **`encounter.ts:422-437` ` LAB ` PROV_NAME suppression is intentionally narrower than the
    sentinel id-set** (catches unenumerated lab resources) AND role-scoped (PART only, REF
    allowed). Centralize as `isNonHumanResource()`; do NOT fold into `SENTINEL_SER_IDS`.
17. **`practitioner.ts:99-212 npiTaxonomyBySer`** uses a looser `startsWith('LAST, FIRST')`
    prefix match with conflict-dropping on denormalized billing names — a different matcher.
    Keep separate from `empLoginToSerId`/`nameToSerId`.
18. **`obs-smartdata.ts:135-138` mints `id.practitioner(CUR_VALUE_USER_ID)` directly** — a
    latent wrong-id-space bug (USER_ID is EMP, not SER). On consolidation SWITCH it to
    `empLoginToSerId()` — a **fix**, not a mechanical move. (Table dormant; never fires today.)
19. **`immunization.ts:175-185`** retains `{display: empName}` even when EMP→SER fails, paired
    with `function.coding 'AP'`. Helper returns id only; caller keeps composing performer.
20. **`lab.ts:651-656` org refs use the `'LLB-'+RESULT_LAB_ID` key namespace**, distinct from
    the SERV_AREA_ID space. `orgRef(key)` is fine but the `'LLB-'` prefix is passed by the
    caller — do not collapse the two key spaces.

**Value / emit shaping**
21. **`eob.ts:82` / `claim.ts:243` round computed sums to cents.** `money()` exposes
    `opts.round`; do not collapse into the bare text parser (totals lose cent-rounding).
22. **`condition.ts:71` vs `allergy.ts:50 clinicalStatus`** share the `{Active,Resolved,
    Inactive}` MAP but emit different system URIs AND a version-policy split (condition pins
    `4.0.0`, allergy omits version deliberately). MAP moves to `enumMap`; system+version stay
    per-domain — do NOT unify into one `clinicalStatus()`.
23. **Per-domain `*_C_NAME`→code maps stay co-located** (immunization status ≠ careplan goal
    status; OMB race is US-Core-specific). Only `enumMap`'s mechanism is shared; centralizing
    the tables would create a god-module and risk cross-domain key collisions.
24. **`coverageeligibility.ts:93-104 networkCC/benefitType`** is domain code-derivation
    (regex In/Out→code, emit coding only when a real THO code exists). It CALLS `cc()`
    internally; the decision logic stays in the domain file.
25. **`lab.ts:678-685` builds a MULTI-coding `code[]`** (CPT + panel-LOINC) conditionally.
    `cc()` is a peer pushed per entry, not a replacement for the conditional assembly.
26. **`condition.ts:116-137 CATEGORY_ENCOUNTER_DX` is 2-element** → `category()` MUST be
    variadic.
27. **`patient.ts:308-324 telecom` is a ContactPoint** (`{system,value,use,rank}`), not an
    Identifier. Do NOT route through `ident()` — it would mis-type and drop `rank`.
28. **`obs-social.ts:108-130 latestSnapshot` is a whole-row snapshot** (ORDER BY date DESC
    LIMIT 1), NOT a per-column latest. Keep whole-row semantics distinct from any
    latest-non-null helper.

**Guard model**
29. **`obs-smartdata.ts:61-144` is the GUARD MODEL, not a duplicate to delete.** Refactor it
    to USE `qIf`/`tablesPresent`/`hasColumn`/`colSet` while keeping its defensive intent (must
    still return `[]` on the absent store).

---

## 4. Sequenced execution plan

Each step is a self-contained safe refactor with its verification. Steps grouped by `[G#]`
may land together. **PV** = portability level unblocked.

### Phase A — pure-move DRY (output byte-identical). Lands in any order; group for fewer PRs.

- **[G0] Rename the terminology-crosswalk layer `answer-key` → `apply-crosswalk` (disambiguation).**
  "answer key" is overloaded: the `--answer-key` FLAG = the terminology crosswalk (sense #1), but
  "answer key" in report prose = the Epic-FHIR `fhir-target/` reference we grade against (sense #2). Hard
  rename sense #1 only (USER 2026-06-18: `--apply-crosswalk`/`out-crosswalk`, NO alias):
  - `--answer-key` flag → **`--apply-crosswalk`** (build.ts; hard break, no alias)
  - `out-answerkey/` dir → **`out-crosswalk/`** (build.ts + ~15 live refs: compare/classify.ts,
    tools/{apply,build-report-data,build-viewer,coding-coverage,floor-audit,refcheck,status,triage}.ts, report/*)
  - `tools/apply-answer-key.ts` → **`tools/apply-crosswalk.ts`**; `applyAnswerKey` → `applyCrosswalk`
  - `ANSWERKEY SUMMARY` log → **`CROSSWALK SUMMARY`**; `ANSWER-KEY-EVAL.md` → **`CROSSWALK-EVAL.md`**
  - sense #2 prose ("answer key" meaning the reference) → **"reference target"** in docs/comments
    (README, report/*, build.ts comments, etc.); `fhir-target/` + `crosswalk/` dirs already well-named.
  - LEAVE historical `workflow-round*.js`/`workflow-answerkey.js` (past run artifacts, not re-run).
  **Verify (pure move):** `bun build.ts --apply-crosswalk` writes `out-crosswalk/` **byte-identical** to
  today's `out-answerkey/` (`diff -r`); `grep -rl 'answer-key\|answerkey\|ANSWERKEY' <live files>` → empty;
  classify/status/floor-audit/triage/build-report-data still reconcile against `out-crosswalk/`. (Risk L.)
- **[G1] `lib/fmt.ts`: `nn`, `money`, `enumMap`, `coalesceName`, `titleCaseName`.**
  Create the module from the canonical seeds. Replace the 10 `nn` copies + patient `ANY`,
  6 `money` copies (with `opts.round` wired so eob/claim:243 use the round path), enum-lookup
  idioms, coalesce idioms, and the `tc` closure. **Verify:** build + classify; `out/` diff
  must be empty. (Risk L.)
- **[G2] `lib/cc.ts`: `cc`, `concept`, `category`, `ident`.** Replace the ~70 inline CC/ident
  sites. `category` variadic (DNM #26). coverageeligibility/lab keep their decision logic and
  CALL `cc()` (DNM #24, #25). Do not touch patient telecom (DNM #27). **Verify:** `out/` diff
  empty; `bun tools/validate.ts <Type>` no new errors. (Risk L.)
- **[G3] time date-only + UTC-column moves (NO instant conversion yet):** `lib/db.ts`
  `naiveLocal`; `lib/time.ts` `isoDate` + `utcFromUtcColumn`; obs-social imports
  `dateRealToISO`. Replace the 9 `isoDate`/`dateOnly` copies + ~6 inline idioms, the 2
  UTC-column readers (lab, medication — DNM #2), and obs-social `dateRealIso`. **No tz
  routine changes here.** **Verify:** `out/` diff empty. (Risk L.)
- **[G4] provider pure moves:** `lib/providers.ts` with `SENTINEL_SER_IDS`,
  `CARE_PROV_COLUMNS`, `referencedProviderIds`, `emittedPractitionerIds`, `provName`,
  `practitionerRef`, `orgRef`, `isNonHumanResource`. communication consumes
  `emittedPractitionerIds` instead of re-deriving. Keep `'LLB-'` prefix at lab call site
  (DNM #20); keep encounter ` LAB ` semantics via `isNonHumanResource` (DNM #16). **Verify:**
  `out/` diff empty; `bun tools/refcheck.ts` — no new dangling refs. (Risk L.)

### Phase B — OID centralization (pure move now; unblocks different-org).

- **[G5] `lib/ids.ts`: `EPIC_INSTANCE_OID`, `epicOid`, `epicOidRaw`, `SYS`, `STD`.** Rewrite
  the ~49 `.283` literals across 18 files to compose from `epicOid`/`SYS.*`. Per-file
  `SYS_*`/`OID_*` names may stay as local aliases = `SYS.X` for minimal churn. Honor child-node
  and bare-OID distinctions (DNM #8, #9, #10, #11, #12); fix the patient.ts:51 comment (DNM #13).
  **Verify (critical):** with `EHI_INSTANCE_OID` unset, `out/` diff MUST be byte-empty (proves
  pure move). Then a one-off `EHI_INSTANCE_OID=9.9.9 bun build.ts` smoke test shows every Epic
  system flips and no `1.2.840.114350.1.13.283` literal survives (`grep`). **PV: different-org
  OID.** (Risk L now; enables H at a new org.)

### Phase C — patient anchor derivation (same-org reuse).

- **[G6] Derive `PATIENT_PAT_ID` + `COVERAGE_ID`.** `lib/ids.ts:12` → `process.env.EHI_PAT_ID
  ?? q1("SELECT PAT_ID FROM PATIENT LIMIT 1")?.PAT_ID` (error on 0 rows); defensively replace
  the `patient.ts:129` `!`. Derive `COVERAGE_ID` (coverageeligibility:67) from the patient's
  COVERAGE/BENEFITS row. **Verify:** for THIS patient (`EHI_PAT_ID` resolves to `Z7004242`,
  `COVERAGE_ID` to `5934765`) `out/` diff empty. Smoke: a fresh single-patient export builds
  without throwing. **PV: same-org new patient** (audit fix #1, #2). (Risk L same-org / H new
  patient — intended.)

### Phase D — table guards (different-org thin subset).

- **[G7] `lib/db.ts`: `qIf`, `tablesPresent`, `hasColumn`, `colSet`.** Refactor
  obs-smartdata + location-org onto them (DNM #29). Add guards to the 7 unguarded generators
  (medication, lab, servicerequest, obs-vitals, obs-survey, encounter, condition) around each
  top-level `q(SELECT ... FROM <optionalTable>)`. **Verify:** full-DB `out/` diff empty
  (guards are no-ops when tables present). Subset smoke: drop an optional table from a copy of
  the DB → build degrades to false-absence, no crash. **PV: different-org thin subset** (audit
  fix #5). (Risk M — pure move on full DB; new behavior only on absent tables.)

### Phase E — timezone unification (intended output diffs; different-tz org).

- **[G8] `lib/time.ts`: `localToUtcInstant` (+ `EHI_TZ`) and `localMidnightToUtcInstant`.**
  Repoint encounter, communication, obs-vitals, obs-survey, allergy onto `localToUtcInstant`
  and obs-social onto `localMidnightToUtcInstant`. Lab keeps its sibling-derived path via
  `localToUtcInstant(local, {utcSibling})` (DNM #1). Medication stays on `utcFromUtcColumn`
  (DNM #2). communication date-only falls back to `isoDate()` (DNM #5).
  **Intended diffs (this step is NOT byte-identical):**
  - **allergy** `recordedDate`: the buggy fixed Eastern `-5`-no-DST is corrected to the
    configured tz (DNM #4) — values may shift by an hour for summer rows. This is the fix.
  - encounter/obs-vitals/obs-survey/obs-social/communication: if the new real-tz routine and
    the hand-rolled nth-Sunday DST agree (they should for `America/Chicago`), those instants
    stay identical; ANY diff here is a regression to investigate, NOT an accepted change.
  **Verify:** `out/` diff is EXPECTED only on allergy (and only summer-DST rows); every other
  instant must match the pre-step output exactly. Enumerate the allergy diffs and confirm each
  equals the now-correct tz instant. **PV: different-tz org** (audit fix #4). (Risk H.)

### Phase F — provider semantic unification + latent-bug fix.

- **[G9] EMP→SER bridge + obs-smartdata fix.** `empLoginToSerId`/`empToSerMap`/`nameToSerId`
  replace the 5 inline EMP→SER reimplementations; each CALLER keeps its drop-vs-display policy
  (DNM #14, #15, #19). Switch `obs-smartdata.ts:135-138` to `empLoginToSerId` (DNM #18 — a
  fix). **Verify:** `out/` diff empty for the 5 active call sites (same matches, same policy);
  obs-smartdata stays empty in this export (table dormant) so no output change today, but the
  id-space is now correct for any org that ships it. (Risk M.)

---

## 5. Risk + regression strategy

**The harness already exists** (`tools/`): `compare/classify.ts` (builds `compare/LEDGER.json`,
the byte-level EXACT/TOLERATED/ACCEPT ledger), `tools/status.ts` (the scorecard reading the
ledger), `tools/refcheck.ts` (id-independent reference-graph integrity — dangling refs, type
violations, naked-display), `tools/validate.ts` (official HL7 R4 validator per resource type).

**The invariant for every PURE-MOVE step (Phases A–D, G5/G6 same-org):**
1. Snapshot `out/` before (`bun build.ts`).
2. Apply the refactor.
3. `bun build.ts` again; `diff -r` the two `out/` trees → **must be empty**. A pure move that
   changes any byte is a defect in that step, full stop.
4. `bun tools/refcheck.ts` → no new dangling/type errors.
5. `bun tools/validate.ts <touched types>` → no new errors.
6. `compare/classify.ts` + `bun tools/status.ts` → EXACT/TOLERATED/ACCEPT counts unchanged.

**For BEHAVIOR-UNIFYING steps (G8 timezone; G7 on a thinned DB):** the `out/` diff is
NON-empty BY DESIGN and is the deliverable to review. The rule is *bounded surprise*: the diff
must match the per-step enumerated set (G8: allergy summer-DST rows only; everything else
byte-identical) and nothing else. Any out-of-scope diff is a regression.

**OID safety (G5):** prove pure-move with `EHI_INSTANCE_OID` unset (`out/` identical), THEN
prove portability with `EHI_INSTANCE_OID=9.9.9` (all Epic systems flip; `grep -r
'1.2.840.114350.1.13.283' src/` returns nothing). Two proofs, two postures.

**Sequencing rationale.** Phases A–B are zero-output-risk and shrink every later diff (fewer
literals, one CC shape) — land first. C unblocks same-org reuse with one derive. D is a no-op
on the full DB (safe to land before E). E is the only large intended-diff step and is isolated
last among the portability fixes so its diff is the ONLY thing under review at that point. F is
last because it carries the one latent-bug fix and the policy-sensitive EMP→SER unification.

**Audit §7 subsumption.** This plan covers audit fixes #1 (G6 `PATIENT_PAT_ID`), #2 (G6
`COVERAGE_ID`), #3 (G5 `.283` OID), #4 (G8 timezone), #5 (G7 table guards), and the #8
SENTINELS/CARE_PROV_COLUMNS share (G4). Audit fixes #6 (baked SERV_AREA `'18'`/
`MINTED_ORG_SERV_AREAS`) and #7 (broaden `'Lab Collect'`/vitals-template gates) are
**derive-from-export / config-widening**, NOT deduplication — they are out of this
consolidation's scope and remain standalone audit items (noted so the plan does not silently
claim them). After G5–G8 a different-org patient builds; after G6 a same-org patient builds.
