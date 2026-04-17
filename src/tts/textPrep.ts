import type { Glossary, TranslatedChunk } from "../types.js";
import { guardGlossaryTerms } from "./glossaryGuard.js";

export interface TtsInput {
  // The field to set on the Google TTS request: "text" (plain) or "markup" (pause tags).
  field: "text" | "markup";
  content: string;
  hasPauses: boolean;
  characters: number; // used for cost tracking + meta cache key
  glossaryPatches: Array<{ term: string; from: string; to: string }>;
  guardWarnings: string[];
}

/**
 * Prepare the string to send to Chirp 3 HD.
 *
 * Preference order for the source text:
 *   1. tieredText (from the pause-refinement pass, e.g. "... [pause short] ...")
 *   2. thaiTextWithPauses (raw [P] from translator) — but this is only used via fallbackTier elsewhere
 *   3. thaiText (no pauses)
 *
 * If the string contains any [pause*] tag, send as "markup"; otherwise "text".
 */
export function prepareTtsInput(
  chunk: TranslatedChunk,
  glossary: Glossary,
  tieredText?: string,
): TtsInput {
  const raw = tieredText ?? chunk.thaiText;

  // Glossary pass — ensures English terms stay Latin script so Chirp code-switches.
  const guard = guardGlossaryTerms(raw, glossary);
  const normalized = normalizeLatinSpacing(guard.text);
  const hasPauses = /\[pause(?:\s+short|\s+long)?\]/.test(normalized);

  return {
    field: hasPauses ? "markup" : "text",
    content: normalized,
    hasPauses,
    characters: normalized.length,
    glossaryPatches: guard.patches,
    guardWarnings: guard.warnings,
  };
}

// Ensure Latin-script runs have single spaces around them so Chirp tokenizes them
// as distinct foreign words. Also collapse accidental double spaces.
export function normalizeLatinSpacing(s: string): string {
  // Insert a space between Thai char and Latin char if missing (both directions).
  let out = s.replace(/([\u0E00-\u0E7F])([A-Za-z])/g, "$1 $2");
  out = out.replace(/([A-Za-z])([\u0E00-\u0E7F])/g, "$1 $2");
  // Collapse any resulting multi-space runs.
  out = out.replace(/[ \t]+/g, " ").trim();
  return out;
}
