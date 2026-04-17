// Rough Thai syllable counter for ±15% validation.
// Strips Latin-script terms (glossary keep-english words), then counts
// Thai consonant onsets (U+0E01–U+0E2E) as a proxy for syllable count.
// Good enough for MVP; replace with a real tokenizer for production.
export function countThaiSyllables(text: string): number {
  const thaiOnly = text.replace(/[A-Za-z0-9_\-.]+/g, "");
  const consonants = thaiOnly.match(/[\u0E01-\u0E2E]/g) ?? [];
  return consonants.length;
}
