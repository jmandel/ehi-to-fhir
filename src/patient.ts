/**
 * patient.ts — the ONE FHIR Patient resource from the Epic EHI export.
 *
 * SOURCE OF TRUTH: the PATIENT base table + its 1:1 numbered supplement stack
 * (PATIENT_2..6, joined on PAT_ID, §8) plus the LINE-multiple demographic spokes
 * (PATIENT_RACE, PATIENT_ALIAS, IDENTITY_ID, PAT_ADDRESS, PAT_EMAILADDRESS,
 * OTHER_COMMUNCTN, PAT_ADDR_CHNG_HX, PAT_RELATIONSHIPS) — see demographics.md.
 *
 * This specimen is a VALUE-CONSISTENT REDACTED copy: MRN, phones, emails, street
 * address and contact names ship as stable replacement tokens ([REDACTED-…]).
 * Per the mapping principles we emit the EHI's value verbatim (a token, not an
 * invention) and rely on join INVARIANTS, never surface format (demographics
 * gotcha 9).
 *
 * WHAT THE EHI FILLS (vs Epic's own FHIR Patient export, fhir-target/Patient.json):
 *   id ........................ PATIENT_ID (= id.patient(); other domains reference it)
 *   active .................... PATIENT_4.PAT_LIVING_STAT_C_NAME = "Alive"
 *   name[official] ........... PATIENT.PAT_FIRST/MIDDLE/LAST + PAT_NAME (packed)
 *   name[old] ................ PATIENT_ALIAS (LINE-multiple display/search aliases)
 *   gender / legal-sex ext .... PATIENT.SEX_C_NAME
 *   genderIdentity ext ....... PATIENT_4.GENDER_IDENTITY_C_NAME
 *   birthsex ext / us-core-sex  PATIENT_4.SEX_ASGN_AT_BIRTH_C_NAME
 *   us-core-race ext ......... PATIENT_RACE (LINE-multiple; OMB code by display map)
 *   us-core-ethnicity ext .... PATIENT.ETHNIC_GROUP_C_NAME (OMB code by display map)
 *   birthDate ................ PATIENT.BIRTH_DATE
 *   deceasedBoolean .......... derived from PAT_LIVING_STAT_C_NAME + DEATH_DATE
 *   address .................. PATIENT base (current) + PAT_ADDR_CHNG_HX (old)
 *   telecom .................. PATIENT.HOME_PHONE / OTHER_COMMUNCTN + PAT_EMAILADDRESS
 *   communication ............ PATIENT.LANGUAGE_C_NAME (+ LANG_WRIT for written proficiency)
 *   contact .................. PAT_RELATIONSHIPS (spouse/emergency) + employer (PATIENT/_2)
 *   identifier ............... IDENTITY_ID (EPI/MRN/IHS) + PAT_ID (EXTERNAL/INTERNAL)
 *                              + MyChart WPRINTERNAL (MYPT_ID)
 *                              + PayerMemberId (COVERAGE_MEMBER_LIST.MEM_NUMBER, Self)
 *   maritalStatus ............ CLM_VALUES.PAT_MAR_STAT (X12-837 code, joined by PAT_MRN)
 *   name[usual] .............. PATIENT_3.PREFERRED_NAME (+ PATIENT_5 preferred-name type);
 *                              preferred-first given tagged iso21090-EN CL qualifier
 *   generalPractitioner ...... PATIENT.CUR_PCP_PROV_ID → Practitioner
 *   managingOrganization ..... facility service-area (Organization org-18)
 *
 * NOT REACHABLE (gaps/patient.md): the Epic-server-assigned identifier VALUES not in
 * the export (FHIR / FHIR STU3 id, CEID, MYCHARTLOGIN; APL surface form), every category
 * CODE (no ZC_ tables, no bare _C — §23: race/ethnicity OMB codes recovered only via a
 * display→code map; language bcp-47 code likewise; relationship v3/v2 codes unrecoverable
 * → text only; birthsex/genderIdentity SNOMED variants absent), and the language-proficiency
 * Epic codings.
 */
import { q, q1, dateRealToISO } from "../lib/db";
import { isoDate } from "../lib/time";
import { id, ref, PATIENT_PAT_ID, epicOid } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, ident } from "../lib/cc";
import { nn as ANY } from "../lib/fmt";

// ---- Epic identifier OID systems ----
// NOTE: these are NOT org-independent — they hang off the Epic ORG-INSTANCE node
// (.283), centralized in lib/ids as EPIC_INSTANCE_OID. A new org flips them all via
// epicOid(); only the open.epic StructureDefinition URLs below are org-independent.
const EPI_OID = epicOid("2.7.5.737384.0"); // EPI enterprise id
const EXTERNAL_OID = epicOid("2.7.2.698084"); // EPT (PAT_ID) EXTERNAL/INTERNAL
const WPRINTERNAL_OID = epicOid("2.7.2.878082"); // MyChart WPR internal id
const PAYER_MEMBER_ID_SYSTEM = "https://open.epic.com/FHIR/StructureDefinition/PayerMemberId";
const IHSMRN_OID = epicOid(""); // Epic root — the IHS-typed MRN ships under it in target
// The org MRN's IDENTITY_ID_TYPE id (955) IS the trailing node of the APL identifier OID.
const MRN_OID_BASE = epicOid("2.7.5.737384."); // + the numeric type id
const LEGAL_SEX_EXT = "http://open.epic.com/FHIR/StructureDefinition/extension/legal-sex";
const GENDER_IDENTITY_EXT = "http://hl7.org/fhir/StructureDefinition/patient-genderIdentity";
const BIRTHSEX_EXT = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex";
const RACE_EXT = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race";
const ETHNICITY_EXT = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity";
const OMB_SYSTEM = "urn:oid:2.16.840.1.113883.6.238"; // CDC Race & Ethnicity
const BCP47 = "urn:ietf:bcp:47";

// --- Display → standard-code maps. The EHI ships NO codes (no ZC_), only the label;
// these maps recover the well-known OMB / ISO codes from that label deterministically.
// If a label is not in the map we emit text only (never guess).
const OMB_RACE: Record<string, { code: string; display: string }> = {
  White: { code: "2106-3", display: "White" },
  "Black or African American": { code: "2054-5", display: "Black or African American" },
  "American Indian or Alaska Native": { code: "1002-5", display: "American Indian or Alaska Native" },
  Asian: { code: "2028-9", display: "Asian" },
  "Native Hawaiian or Other Pacific Islander": { code: "2076-8", display: "Native Hawaiian or Other Pacific Islander" },
};
const OMB_ETHNICITY: Record<string, { code: string; display: string }> = {
  "Hispanic or Latino": { code: "2135-2", display: "Hispanic or Latino" },
  "Not Hispanic or Latino": { code: "2186-5", display: "Not Hispanic or Latino" },
};
const LANG_BCP47: Record<string, string> = {
  English: "en",
  Spanish: "es",
};
// Legal/administrative sex label → birthsex code (M/F).
const BIRTHSEX_CODE: Record<string, string> = { Male: "M", Female: "F" };

// Personal-relationship label → standard HL7 v3 RoleCode (the system Epic's FHIR view
// uses for Patient.contact.relationship). The EHI ships NO relationship code (no ZC_),
// only PAT_REL_RELATION_C_NAME's label; this map recovers the well-known RoleCode for
// the labels that map UNAMBIGUOUSLY to a single role (same display→code convention as the
// OMB-race / bcp-47 maps). An unmapped label yields text only (never guess).
const ROLECODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-RoleCode";
const REL_ROLECODE: Record<string, { code: string; display: string }> = {
  Spouse: { code: "SPS", display: "spouse" },
};

// Marital status: the export ships Epic's numeric EPT-140 category on the 837 claim
// (CLM_VALUES.PAT_MAR_STAT) with NO in-export label table (no ZC_) — so only the LABEL
// is recoverable, via a fixed numeric→label map (same convention as the OMB-race /
// bcp-47 maps above). We emit text only: no marital terminology code is present in the
// export, and the target itself carries maritalStatus as text-only — so emitting a coding
// would be fabricating an EXTRA path. Only the export-verified category ('1' → the
// dominant per-MRN value matching the target text "Married") is mapped; an unmapped code
// yields nothing (never guess a label).
const MARITAL_LABEL_BY_CODE: Record<string, string> = {
  "1": "Married",
};


// State / country labels → the abbreviations Epic's FHIR view uses.
const STATE_ABBR: Record<string, string> = {
  Wisconsin: "WI", Iowa: "IA", Illinois: "IL", Minnesota: "MN", Michigan: "MI",
};
const COUNTRY_ABBR: Record<string, string> = {
  "United States of America": "USA", "United States": "USA",
};
const stateAbbr = (v?: string) => (v ? STATE_ABBR[v] ?? v : undefined);
const countryAbbr = (v?: string) => (v ? COUNTRY_ABBR[v] ?? v : undefined);

function buildPatient(): any {
  const p = q1<Record<string, any>>(`SELECT * FROM PATIENT WHERE PAT_ID = ?`, PATIENT_PAT_ID);
  if (!p) throw new Error(`buildPatient: no PATIENT row for PAT_ID ${PATIENT_PAT_ID}`);
  const p2 = q1<Record<string, any>>(`SELECT * FROM PATIENT_2 WHERE PAT_ID = ?`, PATIENT_PAT_ID) ?? {};
  const p3 = q1<Record<string, any>>(`SELECT * FROM PATIENT_3 WHERE PAT_ID = ?`, PATIENT_PAT_ID) ?? {};
  const p4 = q1<Record<string, any>>(`SELECT * FROM PATIENT_4 WHERE PAT_ID = ?`, PATIENT_PAT_ID) ?? {};
  const p5 = q1<Record<string, any>>(`SELECT * FROM PATIENT_5 WHERE PAT_ID = ?`, PATIENT_PAT_ID) ?? {};

  // -------------------------------------------------------------- extensions
  const extension: any[] = [];

  // legal sex (Epic open.epic extension) — SEX_C_NAME
  const sex = ANY(p.SEX_C_NAME);
  if (sex) {
    extension.push({
      valueCodeableConcept: cc(LEGAL_SEX_EXT_VS_SYSTEM, sex.toLowerCase(), sex.toLowerCase(), sex),
      url: LEGAL_SEX_EXT,
    });
  }

  // gender identity — PATIENT_4.GENDER_IDENTITY_C_NAME
  const gi = ANY(p4.GENDER_IDENTITY_C_NAME);
  if (gi) {
    extension.push({
      valueCodeableConcept: cc("http://hl7.org/fhir/gender-identity", gi.toLowerCase(), gi.toLowerCase(), gi),
      url: GENDER_IDENTITY_EXT,
    });
  }

  // birthsex — PATIENT_4.SEX_ASGN_AT_BIRTH_C_NAME → M/F
  const sab = ANY(p4.SEX_ASGN_AT_BIRTH_C_NAME);
  const birthsex = sab ? BIRTHSEX_CODE[sab] : undefined;
  if (birthsex) extension.push({ valueCode: birthsex, url: BIRTHSEX_EXT });

  // us-core-race — PATIENT_RACE (LINE-multiple)
  const races = q<{ R: string }>(
    `SELECT PATIENT_RACE_C_NAME AS R FROM PATIENT_RACE WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  ).map((r) => ANY(r.R)).filter(Boolean) as string[];
  if (races.length) {
    const sub: any[] = [];
    for (const r of races) {
      const omb = OMB_RACE[r];
      if (omb) sub.push({ valueCoding: { system: OMB_SYSTEM, code: omb.code, display: omb.display }, url: "ombCategory" });
    }
    for (const r of races) sub.push({ valueString: r, url: "text" });
    extension.push({ extension: sub, url: RACE_EXT });
  }

  // us-core-ethnicity — PATIENT.ETHNIC_GROUP_C_NAME (single)
  const eth = ANY(p.ETHNIC_GROUP_C_NAME);
  if (eth) {
    const sub: any[] = [];
    const omb = OMB_ETHNICITY[eth];
    if (omb) sub.push({ valueCoding: { system: OMB_SYSTEM, code: omb.code, display: omb.display }, url: "ombCategory" });
    sub.push({ valueString: eth, url: "text" });
    extension.push({ extension: sub, url: ETHNICITY_EXT });
  }

  // -------------------------------------------------------------- identifiers
  const identifier: any[] = [];
  // IDENTITY_ID rows (EPI / MRN MAPL / IHS). Each row carries its own typed code and a
  // numeric IDENTITY_TYPE_ID; for the org MRN that type id (955) IS the trailing node of
  // the APL identifier OID, so the system is derivable from the export (no fabrication).
  const idRows = q<{ V: string; T: string; TID: string }>(
    `SELECT IDENTITY_ID AS V, IDENTITY_TYPE_ID_ID_TYPE_NAME AS T, IDENTITY_TYPE_ID AS TID
       FROM IDENTITY_ID WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  for (const r of idRows) {
    const v = ANY(r.V);
    const t = ANY(r.T);
    const tid = ANY(r.TID);
    if (!v) continue;
    if (t === "EPI") {
      identifier.push(ident(EPI_OID, v, { use: "usual", type: { text: "EPI" } }));
    } else if (t && t.startsWith("MRN") && tid) {
      // Org MRN (type "MRN MAPL", type id 955). System = .737384.<type id>; value is the
      // display MRN (= PATIENT.PAT_MRN_ID, byte-identical, verified). Keep the EHI's label.
      identifier.push(ident(MRN_OID_BASE + tid, v, { use: "usual", type: { text: t } }));
    } else if (t === "IHS") {
      // IHS-typed external code — ships under the Epic root in the target (type "IHSMRN").
      identifier.push(ident(IHSMRN_OID, v, { use: "usual", type: { text: "IHSMRN" } }));
    }
  }
  // EPT key (PAT_ID): EXTERNAL = trimmed, INTERNAL = padded-left (target shows "  Z7004242").
  identifier.push(ident(EXTERNAL_OID, PATIENT_PAT_ID, { use: "usual", type: { text: "EXTERNAL" } }));
  identifier.push(ident(EXTERNAL_OID, "  " + PATIENT_PAT_ID, { use: "usual", type: { text: "INTERNAL" } }));
  // MyChart WPR internal id (MYPT_ID).
  const myc = q1<{ MYPT_ID: string }>(`SELECT MYPT_ID FROM PATIENT_MYC WHERE PAT_ID = ?`, PATIENT_PAT_ID);
  const mypt = ANY(myc?.MYPT_ID);
  if (mypt) identifier.push(ident(WPRINTERNAL_OID, mypt, { use: "usual", type: { text: "WPRINTERNAL" } }));
  // PayerMemberId (open.epic) — the patient's OWN coverage member number. Sourced from
  // the Coverage domain but keyed to THIS PAT_ID: COVERAGE_MEMBER_LIST rows where the
  // member's relation to subscriber is "Self" carry the patient's member id (byte-identical
  // to the target's PayerMemberId). A patient may hold several coverages; emit each distinct
  // Self member number once.
  const payerMemberIds = q<{ M: string }>(
    `SELECT DISTINCT MEM_NUMBER AS M FROM COVERAGE_MEMBER_LIST
       WHERE PAT_ID = ? AND MEM_REL_TO_SUB_C_NAME = 'Self' AND TRIM(MEM_NUMBER) <> ''`,
    PATIENT_PAT_ID
  );
  for (const pm of payerMemberIds) {
    const v = ANY(pm.M);
    if (v) identifier.push(ident(PAYER_MEMBER_ID_SYSTEM, v, { use: "usual" }));
  }

  // -------------------------------------------------------------- name
  const name: any[] = [];
  const family = ANY(p.PAT_LAST_NAME);
  const first = ANY(p.PAT_FIRST_NAME);
  const middle = ANY(p.PAT_MIDDLE_NAME);
  const given = [first, middle].filter(Boolean) as string[];
  if (family || given.length) {
    name.push({
      use: "official",
      text: [given.join(" "), family].filter(Boolean).join(" ") || undefined,
      family,
      given: given.length ? given : undefined,
    });
  }
  // Preferred / "usual" name — PATIENT_3.PREFERRED_NAME is the structured preferred
  // FIRST name (PATIENT_5.PREFERRED_NAME_TYPE_C_NAME = "First Name, Preferred" tells us
  // it is the FIRST name that is preferred). Reconstruct given = [preferred-first, middle],
  // family = legal last; tag ONLY the preferred-first given part with the iso21090-EN
  // "CL" (call-me) qualifier via the parallel _given array. Suppress if the preferred
  // first name is identical to the legal first (no distinct "usual" form to surface).
  const EN_QUALIFIER = "http://hl7.org/fhir/StructureDefinition/iso21090-EN-qualifier";
  const prefFirst = ANY(p3.PREFERRED_NAME);
  const prefType = ANY(p5.PREFERRED_NAME_TYPE_C_NAME);
  if (prefFirst && prefType === "First Name, Preferred" && prefFirst !== first) {
    const usualGiven = [prefFirst, middle].filter(Boolean) as string[];
    name.push({
      use: "usual",
      text: [usualGiven.join(" "), family].filter(Boolean).join(" ") || undefined,
      family,
      given: usualGiven.length ? usualGiven : undefined,
      // Parallel array: index 0 (the preferred first name) carries the CL qualifier;
      // the middle part has no extension (trailing nulls omitted per FHIR).
      _given: [{ extension: [{ valueCode: "CL", url: EN_QUALIFIER }] }],
    });
  }

  // Aliases (PATIENT_ALIAS) — display/search names, use "old". Packed "LAST,FIRST".
  const aliases = q<{ A: string }>(
    `SELECT ALIAS AS A FROM PATIENT_ALIAS WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  for (const a of aliases) {
    const raw = ANY(a.A);
    if (!raw) continue;
    const [last, ...rest] = raw.split(",");
    const givenAlias = rest.join(",").trim();
    name.push({
      use: "old",
      text: raw,
      family: ANY(last),
      given: givenAlias ? [givenAlias] : undefined,
    });
  }

  // -------------------------------------------------------------- telecom
  const telecom: any[] = [];
  // Phones from OTHER_COMMUNCTN (the fuller list: Home / Work / Mobile / Text).
  const comms = q<{ TYPE: string; NUM: string; PRI: string }>(
    `SELECT OTHER_COMMUNIC_C_NAME AS TYPE, OTHER_COMMUNIC_NUM AS NUM, CONTACT_PRIORITY AS PRI
       FROM OTHER_COMMUNCTN WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  const PHONE_USE: Record<string, string> = { "Home Phone": "home", "Work Phone": "work", Mobile: "mobile" };
  for (const c of comms) {
    const num = ANY(c.NUM);
    const type = ANY(c.TYPE);
    if (!num) continue; // a typed-but-empty channel is a placeholder, not a number (§39/§46)
    const use = type ? PHONE_USE[type] : undefined;
    const t: any = { system: "phone", value: num, use };
    if (use === "mobile" && ANY(c.PRI)) t.rank = Number(c.PRI);
    telecom.push(t);
  }
  // Home phone fallback if OTHER_COMMUNCTN carried none.
  if (!telecom.some((t) => t.use === "home")) {
    const hp = ANY(p.HOME_PHONE);
    if (hp) telecom.push({ system: "phone", value: hp, use: "home" });
  }
  // Emails (PAT_EMAILADDRESS, LINE-multiple). First gets rank 1 (the registration primary).
  const emails = q<{ E: string }>(
    `SELECT EMAIL_ADDRESS AS E FROM PAT_EMAILADDRESS WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  emails.forEach((e, i) => {
    const v = ANY(e.E);
    if (v) telecom.push({ system: "email", value: v, ...(i === 0 ? { rank: 1 } : {}) });
  });

  // -------------------------------------------------------------- address
  const address: any[] = [];
  const district = ANY(p.COUNTY_C_NAME);
  const state = stateAbbr(ANY(p.STATE_C_NAME));
  const country = countryAbbr(ANY(p.COUNTRY_C_NAME));
  const city = ANY(p.CITY);
  const zip = ANY(p.ZIP);
  // Current street lines from PAT_ADDRESS (LINE-multiple).
  const streetLines = q<{ A: string }>(
    `SELECT ADDRESS AS A FROM PAT_ADDRESS WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  ).map((r) => ANY(r.A)).filter(Boolean) as string[];
  // Current period start = when the patient began RESIDING at the current location —
  // not merely when the latest history row opened. PAT_ADDR_CHNG_HX records a new row for
  // EVERY edit, including cosmetic street-line corrections that do NOT move the patient
  // (e.g. "[ADDRESS-REDACTED]" → "[ADDRESS-REDACTED]", same MADISON/DANE/53726). Epic's
  // FHIR view stamps the current address's period.start with the EARLIEST start of the
  // unbroken run of same-physical-location rows ending in the open row (demographics:
  // a location is identified by city+county+zip, which survive the street-line edit).
  const histRows = q<Record<string, any>>(
    `SELECT * FROM PAT_ADDR_CHNG_HX WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  const curHist = histRows.find((h) => !ANY(h.EFF_END_DATE));
  // Earliest start of the contiguous current-residence run (same city/county/zip as the
  // open row). Walk the start-ordered rows backward from the open row; stop at the first
  // row whose location differs (a genuine move).
  let curStart = curHist ? isoDate(curHist.EFF_START_DATE) : undefined;
  if (curHist) {
    const locKey = (h: Record<string, any>) =>
      [ANY(h.CITY_HX), ANY(h.COUNTY_HX_C_NAME), ANY(h.ZIP_HX)].map((x) => x ?? "").join("|");
    const curKey = locKey(curHist);
    const byStart = [...histRows]
      .filter((h) => isoDate(h.EFF_START_DATE))
      .sort((a, b) => String(isoDate(a.EFF_START_DATE)).localeCompare(String(isoDate(b.EFF_START_DATE))));
    for (let i = byStart.length - 1; i >= 0; i--) {
      if (locKey(byStart[i]) !== curKey) break;
      curStart = isoDate(byStart[i].EFF_START_DATE);
    }
  }
  if (streetLines.length || city || zip) {
    const lines = streetLines.length ? streetLines : (ANY(curHist?.ADDR_HX_LINE1) ? [String(curHist!.ADDR_HX_LINE1).trim()] : []);
    address.push({
      use: "home",
      text: [...lines, [city, state, zip].filter(Boolean).join(" "), ANY(p.COUNTRY_C_NAME)].filter(Boolean).join("\r\n") || undefined,
      line: lines.length ? lines : undefined,
      city, district, state, postalCode: zip, country,
      period: curStart ? { start: curStart } : undefined,
    });
  }
  // Prior addresses (rows with an EFF_END_DATE), use "old".
  for (const h of histRows) {
    if (!ANY(h.EFF_END_DATE)) continue;
    const line1 = ANY(h.ADDR_HX_LINE1);
    const hcity = ANY(h.CITY_HX);
    const hzip = ANY(h.ZIP_HX);
    const hdist = ANY(h.COUNTY_HX_C_NAME);
    const hcountry = ANY(h.COUNTRY_C_NAME);
    if (!line1 && !hcity && !hzip) continue;
    address.push({
      use: "old",
      text: [line1, [hcity, state, hzip].filter(Boolean).join(" "), hcountry].filter(Boolean).join("\r\n") || undefined,
      line: line1 ? [line1] : undefined,
      city: hcity, district: hdist, state, postalCode: hzip, country: countryAbbr(hcountry),
      period: { start: isoDate(h.EFF_START_DATE), end: isoDate(h.EFF_END_DATE) },
    });
  }

  // -------------------------------------------------------------- communication
  // Spoken language = LANGUAGE_C_NAME (the care/verbal language); written = LANG_WRIT_C_NAME.
  // The EHI tells us, per modality, which language applies — that maps deterministically
  // onto the FHIR language-ability-mode (ESP spoken / EWR written) proficiency extensions
  // and the language-preference-type (verbal/written) subtags on `preferred`.
  const communication: any[] = [];
  const lang = ANY(p.LANGUAGE_C_NAME);
  const langWrit = ANY(p.LANG_WRIT_C_NAME);
  if (lang) {
    const bcp = LANG_BCP47[lang];
    const ABILITY = "http://terminology.hl7.org/CodeSystem/v3-LanguageAbilityMode";
    const PREF_TYPE = "http://hl7.org/fhir/language-preference-type";
    const PROF_EXT = "http://hl7.org/fhir/StructureDefinition/patient-proficiency";
    const PREF_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/patient-preferenceType";

    const proficiency: any[] = [];
    const prefTypes: any[] = [];
    // Verbal/spoken: present whenever the EHI records a spoken care language.
    proficiency.push({
      extension: [{ valueCoding: { system: ABILITY, code: "ESP", display: "Expressed spoken" }, url: "type" }],
      url: PROF_EXT,
    });
    prefTypes.push({ valueCoding: { system: PREF_TYPE, code: "verbal", display: "verbal" }, url: PREF_TYPE_EXT });
    // Written: present only when LANG_WRIT_C_NAME is populated.
    if (langWrit) {
      proficiency.push({
        extension: [{ valueCoding: { system: ABILITY, code: "EWR", display: "Expressed written" }, url: "type" }],
        url: PROF_EXT,
      });
      prefTypes.push({ valueCoding: { system: PREF_TYPE, code: "written", display: "written" }, url: PREF_TYPE_EXT });
    }

    communication.push({
      extension: proficiency,
      language: {
        coding: bcp ? [{ system: BCP47, code: bcp, display: lang }] : undefined,
        text: lang,
      },
      preferred: true,
      _preferred: { extension: prefTypes },
    });
  }

  // -------------------------------------------------------------- contact
  const contact: any[] = [];
  // Emergency / relationship contacts from PAT_RELATIONSHIPS (EPT side, inline name+phone).
  const rels = q<Record<string, any>>(
    `SELECT * FROM PAT_RELATIONSHIPS WHERE PAT_ID = ? ORDER BY CAST(LINE AS INT)`,
    PATIENT_PAT_ID
  );
  for (const r of rels) {
    const relName = ANY(r.PAT_REL_NAME);
    const relType = ANY(r.PAT_REL_RELATION_C_NAME); // e.g. "Spouse" (code unrecoverable, §23)
    const mobile = ANY(r.PAT_REL_MOBILE_PHNE);
    const home = ANY(r.PAT_REL_HOME_PHONE);
    const work = ANY(r.PAT_REL_WORK_PHONE);
    if (!relName && !relType) continue;
    // Is this contact flagged as an emergency contact on the RLA master row?
    const rlaId = ANY(r.PAT_REL_RLA_ID);
    const isEmergency = rlaId
      ? ANY(q1<{ E: string }>(`SELECT EMERG_CONTACT_YN AS E FROM PAT_RELATIONSHIP_LIST WHERE PAT_RELATIONSHIP_ID = ?`, rlaId)?.E) === "Y"
      : false;

    const relationship: any[] = [];
    if (relType) {
      // Recover the standard v3 RoleCode from the label where unambiguous; the Epic-local
      // .827665.1000 coding the target also carries is server-assigned (no ZC_/code column
      // in the export) → unrecoverable, so it stays out. Text always carries the label.
      const rc = REL_ROLECODE[relType];
      relationship.push(
        rc
          ? cc(ROLECODE_SYSTEM, rc.code, rc.display, relType)
          : { text: relType } // text only — no recoverable code
      );
    }
    if (isEmergency) {
      relationship.push(cc("http://terminology.hl7.org/CodeSystem/v2-0131", "C", "Emergency Contact"));
    }
    const ctel: any[] = [];
    if (mobile) ctel.push({ system: "phone", value: mobile, use: "mobile", rank: 1 });
    if (home) ctel.push({ system: "phone", value: home, use: "home" });
    if (work) ctel.push({ system: "phone", value: work, use: "work" });

    // Contact address: city/zip/county inline on PAT_RELATIONSHIPS (EPT side); the
    // street line lives on the RLA-side PAT_RELATIONSHIP_ADDR and the state on
    // PAT_RELATIONSHIP_LIST — both keyed by PAT_REL_RLA_ID.
    const cCity = ANY(r.PAT_REL_CITY);
    const cZip = ANY(r.PAT_REL_ZIP);
    const cDistrict = ANY(r.PAT_REL_COUNTY_C_NAME);
    const cCountryRaw = ANY(r.PAT_REL_COUNTRY_C_NAME);
    let cLine: string | undefined;
    let cState: string | undefined;
    if (rlaId) {
      cLine = ANY(
        q1<{ A: string }>(
          `SELECT ADDRESS AS A FROM PAT_RELATIONSHIP_ADDR WHERE PAT_RELATIONSHIP_ID = ? ORDER BY CAST(LINE AS INT) LIMIT 1`,
          rlaId
        )?.A
      );
      cState = stateAbbr(
        ANY(q1<{ S: string }>(`SELECT STATE_C_NAME AS S FROM PAT_RELATIONSHIP_LIST WHERE PAT_RELATIONSHIP_ID = ?`, rlaId)?.S)
      );
    }
    const cAddr: any = {
      use: "home",
      text: [cLine, [cCity, cState, cZip].filter(Boolean).join(" "), cCountryRaw].filter(Boolean).join("\r\n") || undefined,
      line: cLine ? [cLine] : undefined,
      city: cCity,
      district: cDistrict,
      state: cState,
      postalCode: cZip,
      country: countryAbbr(cCountryRaw),
    };

    contact.push({
      relationship: relationship.length ? relationship : undefined,
      name: relName ? { use: "usual", text: relName } : undefined,
      telecom: ctel.length ? ctel : undefined,
      address: (cAddr.city || cAddr.postalCode || cAddr.country || cAddr.line) ? cAddr : undefined,
    });
  }
  // Employer contact (PATIENT.EMPLOYER_ID_EMPLOYER_NAME + PATIENT_2 EMPR_* address).
  const employer = ANY(p.EMPLOYER_ID_EMPLOYER_NAME);
  const emprCountry = countryAbbr(ANY(p2.EMPR_COUNTRY_C_NAME));
  if (employer || emprCountry) {
    contact.push({
      relationship: [cc("http://terminology.hl7.org/CodeSystem/v2-0131", "E", "Employer", null)],
      address: emprCountry || ANY(p2.EMPR_CITY)
        ? {
            use: "work",
            city: ANY(p2.EMPR_CITY),
            state: stateAbbr(ANY(p2.EMPR_STATE_C_NAME)),
            postalCode: ANY(p2.EMPR_ZIP),
            country: emprCountry,
          }
        : undefined,
      organization: employer ? { display: employer } : undefined,
    });
  }

  // -------------------------------------------------------------- maritalStatus
  // Source: CLM_VALUES.PAT_MAR_STAT — the X12-837 patient marital status code Epic
  // stamps on each claim. CLM_VALUES has no PAT_ID; join by PAT_MRN (= PATIENT.PAT_MRN_ID,
  // byte-identical, including the redaction token). A patient can appear on many claims;
  // take the dominant (most frequent) code as the current marital status.
  let maritalStatus: any;
  const mrn = ANY(p.PAT_MRN_ID);
  if (mrn) {
    const marRow = q1<{ MS: string }>(
      `SELECT PAT_MAR_STAT AS MS FROM CLM_VALUES
         WHERE PAT_MRN = ? AND TRIM(PAT_MAR_STAT) <> ''
         GROUP BY PAT_MAR_STAT ORDER BY COUNT(*) DESC LIMIT 1`,
      mrn
    );
    const msCode = ANY(marRow?.MS);
    const label = msCode ? MARITAL_LABEL_BY_CODE[msCode] : undefined;
    if (label) maritalStatus = { text: label };
  }

  // -------------------------------------------------------------- gender / dates / status
  const gender = sex ? sex.toLowerCase() : undefined;
  const birthDate = isoDate(p.BIRTH_DATE);

  // Alive/deceased: PAT_LIVING_STAT_C_NAME is authoritative (demographics gotcha 1);
  // corroborate death with DEATH_DATE.
  const living = ANY(p4.PAT_LIVING_STAT_C_NAME);
  const deathDate = ANY(p.DEATH_DATE);
  const active = living ? living === "Alive" : undefined;
  let deceasedBoolean: boolean | undefined;
  let deceasedDateTime: string | undefined;
  if (deathDate) {
    deceasedDateTime = isoDate(deathDate);
  } else if (living === "Alive") {
    deceasedBoolean = false;
  } else if (living === "Deceased") {
    deceasedBoolean = true;
  }

  // -------------------------------------------------------------- references
  // generalPractitioner — CUR_PCP_PROV_ID → Practitioner (resolves in out/Practitioner.json).
  let generalPractitioner: any[] | undefined;
  const pcpId = ANY(p.CUR_PCP_PROV_ID);
  if (pcpId) {
    const ser = q1<{ PROV_NAME: string; EXTERNAL_NAME: string }>(
      `SELECT PROV_NAME, EXTERNAL_NAME FROM CLARITY_SER WHERE PROV_ID = ?`,
      pcpId
    );
    const disp = ANY(ser?.EXTERNAL_NAME) ?? ANY(ser?.PROV_NAME);
    generalPractitioner = [{ ...ref("Practitioner", id.practitioner(pcpId), disp), type: "Practitioner" }];
  }

  // managingOrganization — the facility service area (org-18 in out/Organization.json).
  const fac = q1<{ SERV_AREA_ID: string; SERV_AREA_NAME: string }>(
    `SELECT SERV_AREA_ID, SERV_AREA_NAME FROM CLARITY_SA WHERE SERV_AREA_ID = '18'`
  );
  const managingOrganization = fac
    ? ref("Organization", id.organization(fac.SERV_AREA_ID), ANY(fac.SERV_AREA_NAME))
    : undefined;

  return clean({
    resourceType: "Patient",
    id: id.patient(),
    extension,
    identifier,
    active,
    name,
    telecom,
    gender,
    birthDate,
    maritalStatus,
    deceasedBoolean,
    deceasedDateTime,
    address,
    communication,
    contact,
    generalPractitioner,
    managingOrganization,
  });
}

// open.epic legal-sex extension carries an org-specific value-set OID in the target;
// that OID is server-assigned (not in the EHI), so we keep the system as the bare
// concept system rather than fabricate the .750999123 value-set OID (recorded as gap).
const LEGAL_SEX_EXT_VS_SYSTEM = epicOid("2.7.10.698084.130.657370.750999123");

emit("Patient", [buildPatient()]);
