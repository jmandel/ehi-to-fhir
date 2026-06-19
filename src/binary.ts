/**
 * binary.ts — FHIR Binary resources holding the EXACT note/document bytes from the
 * EHI export, so DocumentReference.content[].attachment.url can point at a Binary that
 * actually resolves WITHIN our bundle (instead of an unreproducible Epic Binary/<opaque>).
 *
 * WHAT WE PRODUCE (opt-in; large — gate with --embed-attachments in build.ts)
 *   For every clinical note we publish a DocumentReference for, the note body is in the
 *   export as `raw/Rich Text/HNO_<NOTE_ID>_*.RTF`. We:
 *     - read the file's EXACT bytes (no transformation),
 *     - mint a CONTENT-ADDRESSED id  `bin-<sha1(bytes)>`  (identical bodies dedup to one
 *       Binary; the id is reproducible, unlike Epic's opaque Binary id),
 *     - emit `{ resourceType:"Binary", id, contentType:"text/rtf", data:<base64 exact bytes> }`.
 *   We also emit a clearly-DERIVED `text/plain` Binary per note (lib/rtf2txt) so a plain-text
 *   rendering travels with the bundle, labeled as a derived rendering (NOT Epic's bytes).
 *
 * SCANNED DOCS (Media)
 *   DOC_INFORMATION.SCAN_FILE names a scanned artifact (PDF/JPG/TIF). We generalize the path
 *   so a present scan file would also become a Binary, but in THIS specimen none of those
 *   files ship in the export (raw/Media holds only _INDEX.HTML), so no scan Binary is emitted
 *   — we never fabricate bytes we don't have.
 *
 * FAITHFULNESS
 *   text/rtf data = exact source bytes. text/plain = derived, labeled. hash = base64 SHA-1 of
 *   the exact bytes (FHIR Attachment.hash convention).
 *
 * The note→attachment metadata mapping is exported (attachmentsForNote) so
 * documentreference.ts populates its content[] attachments from the SAME source of truth.
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { q } from "../lib/db";
import { emit } from "../lib/gen";
import { rtfToText } from "../my-ehi/lib/rtf2txt";
import { PATIENT_ID } from "../lib/ids";
import { publishedNoteIds, publishedImagingOrderIds } from "./documentreference";

const RICH_TEXT_DIR = resolve(import.meta.dir, "..", "my-ehi", "raw", "Rich Text");
const MEDIA_DIR = resolve(import.meta.dir, "..", "my-ehi", "raw", "Media");

/** FHIR Attachment metadata that points at one of our Binary resources. */
export interface AttachmentMeta {
  contentType: string;
  url: string;        // "Binary/<hashid>"
  size: number;       // exact byte length
  hash: string;       // base64-encoded SHA-1 of the exact bytes (FHIR Attachment.hash)
  title?: string;
  creation?: string;
  derived?: boolean;  // true for the text/plain rendering (not the source bytes)
}

interface BinaryRec {
  id: string;
  contentType: string;
  bytes: Buffer;
  hashB64: string;
}

/** Content-addressed id + base64 SHA-1, deduping identical bodies. */
function makeBinary(bytes: Buffer, contentType: string): BinaryRec {
  const sha1 = createHash("sha1").update(bytes).digest();
  return { id: `bin-${sha1.toString("hex")}`, contentType, bytes, hashB64: sha1.toString("base64") };
}

const byExt: Record<string, string> = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".html": "text/html", ".htm": "text/html", ".rtf": "text/rtf", ".txt": "text/plain",
};
function contentTypeForFile(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && byExt[name.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/** NOTE_ID -> the RTF file that carries its body (the body is the join key, §14). */
function rtfFileByNote(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(RICH_TEXT_DIR)) return m;
  for (const f of readdirSync(RICH_TEXT_DIR)) {
    const mm = f.match(/^HNO_(\d+)_/i);
    if (mm && !m.has(mm[1])) m.set(mm[1], f);
  }
  return m;
}

/** Scan-file name (DOC_INFORMATION.SCAN_FILE) -> on-disk path under Media, if it exists. */
function scanFileOnDisk(scanFile: string): string | undefined {
  if (!existsSync(MEDIA_DIR)) return undefined;
  const p = resolve(MEDIA_DIR, scanFile);
  return existsSync(p) ? p : undefined;
}

/**
 * Imaging report body — ORDER_NARRATIVE holds the radiologist's report text for an
 * imaging ORDER_PROC, one row per LINE (the EHI's relational serialization of the
 * report). We reconstruct the EXACT report text (non-archived lines, joined in LINE
 * order) and mint a content-addressed text/plain Binary from those bytes. This is a
 * REAL recovered body (not Epic's text/html Binary, whose bytes are not in the export);
 * we label the contentType honestly as text/plain (the relational narrative we have),
 * the same faithfulness posture as the note text/plain rendering.
 */
function imagingNarrativeText(orderProcId: string): string {
  const lines = q<{ NARRATIVE: string | null }>(
    `SELECT NARRATIVE FROM ORDER_NARRATIVE
      WHERE ORDER_PROC_ID = ? AND (IS_ARCHIVED_YN IS NULL OR IS_ARCHIVED_YN <> 'Y')
      ORDER BY CAST(LINE AS INTEGER)`,
    orderProcId
  );
  return lines.map((l) => (l.NARRATIVE == null ? "" : l.NARRATIVE)).join("\n");
}

// Lazily-built registry, shared across exported helpers and the emitter.
let _registry: {
  binaries: Map<string, BinaryRec>;
  perNote: Map<string, AttachmentMeta[]>;
  perOrder: Map<string, AttachmentMeta[]>;
} | undefined;

function build() {
  if (_registry) return _registry;
  const binaries = new Map<string, BinaryRec>();           // id -> rec (dedup)
  const perNote = new Map<string, AttachmentMeta[]>();     // NOTE_ID -> attachment metas
  const perOrder = new Map<string, AttachmentMeta[]>();    // ORDER_PROC_ID -> attachment metas

  const register = (rec: BinaryRec) => { if (!binaries.has(rec.id)) binaries.set(rec.id, rec); };

  // (A) Clinical-note RTF bodies → text/rtf Binary (+ derived text/plain Binary).
  // ONLY for notes we actually publish a DocumentReference for (no orphan Binaries);
  // publishedNoteIds() is the single source of selection truth (src/documentreference.ts).
  const rtfByNote = rtfFileByNote();
  for (const noteId of publishedNoteIds()) {
    const fname = rtfByNote.get(noteId);
    if (!fname) continue; // published set already requires a body, but be defensive
    const bytes = readFileSync(resolve(RICH_TEXT_DIR, fname));
    const rtfBin = makeBinary(bytes, "text/rtf");
    register(rtfBin);

    const metas: AttachmentMeta[] = [{
      contentType: "text/rtf",
      url: `Binary/${rtfBin.id}`,
      size: bytes.length,
      hash: rtfBin.hashB64,
    }];

    // Derived plain-text rendering (labeled derived; never presented as Epic's bytes).
    let plain = "";
    try { plain = rtfToText(bytes.toString("latin1")); } catch { plain = ""; }
    if (plain.trim()) {
      const txtBytes = Buffer.from(plain, "utf8");
      const txtBin = makeBinary(txtBytes, "text/plain");
      register(txtBin);
      metas.push({
        contentType: "text/plain",
        url: `Binary/${txtBin.id}`,
        size: txtBytes.length,
        hash: txtBin.hashB64,
        derived: true,
      });
    }
    perNote.set(noteId, metas);
  }

  // (B) Scanned documents (Media) → Binary, ONLY when the named file ships in the export.
  // None do in this specimen; the path is here for fuller exports (never fabricates bytes).
  const scans = q<{ SCAN_FILE: string }>(
    `SELECT DISTINCT SCAN_FILE FROM DOC_INFORMATION
      WHERE SCAN_FILE IS NOT NULL AND TRIM(SCAN_FILE) <> ''`
  );
  for (const { SCAN_FILE } of scans) {
    const path = scanFileOnDisk(String(SCAN_FILE).trim());
    if (!path) continue; // no bytes on disk → nothing to emit
    const bytes = readFileSync(path);
    register(makeBinary(bytes, contentTypeForFile(path)));
  }

  // (C) Imaging report bodies (ORDER_NARRATIVE) → text/plain Binary, ONLY for the
  // imaging orders we actually publish a DocumentReference for (no orphan Binaries);
  // publishedImagingOrderIds() is the single source of selection truth.
  for (const orderId of publishedImagingOrderIds()) {
    const text = imagingNarrativeText(orderId);
    if (!text.trim()) continue; // published set already requires a body, but be defensive
    const bytes = Buffer.from(text, "utf8");
    const bin = makeBinary(bytes, "text/plain");
    register(bin);
    perOrder.set(orderId, [{
      contentType: "text/plain",
      url: `Binary/${bin.id}`,
      size: bytes.length,
      hash: bin.hashB64,
    }]);
  }

  _registry = { binaries, perNote, perOrder };
  return _registry;
}

/**
 * Attachment metadata for a note's content[] (text/rtf + optional derived text/plain),
 * enriched with title/creation supplied by the caller (DocumentReference knows the note
 * type + date). Returns [] when the note has no exported body.
 */
export function attachmentsForNote(
  noteId: string,
  opts?: { title?: string; creation?: string }
): AttachmentMeta[] {
  const metas = build().perNote.get(noteId);
  if (!metas) return [];
  return metas.map((m) => ({
    ...m,
    title: m.derived && opts?.title ? `${opts.title} (plain text)` : opts?.title,
    creation: opts?.creation,
  }));
}

/**
 * Attachment metadata for an imaging order's content[] (the recovered ORDER_NARRATIVE
 * report body as text/plain), enriched with title/creation supplied by the caller.
 * Returns [] when the order has no exported narrative body.
 */
export function attachmentsForOrder(
  orderProcId: string,
  opts?: { title?: string; creation?: string }
): AttachmentMeta[] {
  const metas = build().perOrder.get(orderProcId);
  if (!metas) return [];
  return metas.map((m) => ({ ...m, title: opts?.title, creation: opts?.creation }));
}

/** Every minted Binary resource (deduped by content hash). */
export function binaryResources(): any[] {
  return [...build().binaries.values()].map((b) => ({
    resourceType: "Binary",
    id: b.id,
    contentType: b.contentType,
    securityContext: { reference: `Patient/${PATIENT_ID}` },
    data: b.bytes.toString("base64"),
  }));
}

if (import.meta.main) {
  emit("Binary", binaryResources());
}
