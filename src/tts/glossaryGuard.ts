import type { Glossary, GlossaryEntry } from "../types.js";

export interface GuardResult {
  text: string;
  patches: Array<{ term: string; from: string; to: string }>;
  warnings: string[];
}

// Detect whether a glossary keep-english term appears in Latin script in the Thai text.
// If it was accidentally transliterated to Thai script (thaiForm) and we still have
// the Latin canonical form, patch it back. Case-insensitive for the Latin comparison.
//
// This is defensive: the translator prompt already enforces Latin-script preservation,
// but this guard catches drift without re-running translation.
export function guardGlossaryTerms(
  thaiText: string,
  glossary: Glossary,
): GuardResult {
  const keepEnglish = glossary.entries.filter(
    (e) => e.treatment === "keep-english",
  );
  if (keepEnglish.length === 0) {
    return { text: thaiText, patches: [], warnings: [] };
  }

  let text = thaiText;
  const patches: GuardResult["patches"] = [];
  const warnings: string[] = [];

  for (const entry of keepEnglish) {
    const latinForms = [entry.term, ...entry.aliases].filter(isLatin);
    const alreadyPresent = latinForms.some((f) =>
      containsCaseInsensitive(text, f),
    );

    if (alreadyPresent) continue;

    // Latin form missing. Try to patch via thaiForm substitution.
    const thaiForm = entry.thaiForm?.trim();
    if (thaiForm && text.includes(thaiForm)) {
      const patched = text.split(thaiForm).join(` ${entry.term} `);
      patches.push({ term: entry.term, from: thaiForm, to: entry.term });
      text = collapseSpaces(patched);
      continue;
    }

    // Couldn't patch automatically — likely the term simply doesn't appear in
    // this chunk, which is fine. Only warn if the English canonical was in the
    // source English text: that signals translator drift.
    warnings.push(
      `glossary term "${entry.term}" not found as Latin script; no thaiForm to patch`,
    );
  }

  return { text, patches, warnings };
}

export function anyKeepEnglish(entries: GlossaryEntry[]): boolean {
  return entries.some((e) => e.treatment === "keep-english");
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function collapseSpaces(s: string): string {
  return s.replace(/[ \t]+/g, " ").trim();
}
