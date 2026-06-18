/**
 * cc.ts — CodeableConcept / Identifier emit shapes.
 *
 * Pure emit-shaping helpers routed through gen.clean(): a single-coding
 * CodeableConcept (`cc`), a text-only CodeableConcept (`concept`), variadic
 * `category[]` assembly (`category`), and a single Identifier (`ident`).
 *
 * These are byte-compatible drop-in replacements for the ~70 inline shapes
 * spread across the domain generators. `clean()` drops any falsy/empty field,
 * so the emitted bytes match the prior hand-written literals exactly.
 *
 * NOTE: `encounterRef` (the Encounter + CSN-identifier reference) deliberately
 * lives in ids.ts next to id.encounter, because it needs SYS.CSN — not here.
 */
import { clean } from "./gen";

/**
 * Universal single-coding CodeableConcept.
 *   cc(system, code, display)        → text defaults to display
 *   cc(system, code, display, text)  → explicit text
 *   cc(system, code, display, null)  → no text (coding only)
 * Falsy fields (incl. empty text/display) are dropped by clean().
 */
export function cc(
  system: string | undefined,
  code: string | undefined,
  display?: string,
  text?: string | null
): { coding: { system?: string; code?: string; display?: string }[]; text?: string } {
  const resolvedText = text === undefined ? display : text === null ? undefined : text;
  return clean({ coding: [{ system, code, display }], text: resolvedText });
}

/**
 * Text-only CodeableConcept guarded on a possibly-empty label — the dominant
 * shape where the EHI ships no code. Returns undefined for an empty label.
 */
export function concept(text: string | null | undefined): { text: string } | undefined {
  if (!text) return undefined;
  return { text };
}

/**
 * Variadic category[] assembly so per-domain CATEGORY_* consts become
 * category(cc(...)). MUST be variadic — encounter-diagnosis is 2-element.
 */
export function category<T>(...ccs: T[]): T[] {
  return ccs;
}

/**
 * One Identifier {use?, type?, system, value}; undefined for an empty value.
 * Field order (use, type, system, value) matches the prior inline literals.
 */
export function ident(
  system: string | undefined,
  value: unknown,
  opts?: { use?: string; type?: any }
): { use?: string; type?: any; system?: string; value: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return clean({ use: opts?.use, type: opts?.type, system, value: String(value) });
}
