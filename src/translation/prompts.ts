import type { PersonaPack, Glossary, PreprocessedChunk } from "../types.js";

export function buildTranslationSystemPrompt(
  persona: PersonaPack,
  glossary: Glossary,
): string {
  const keepEnglishTerms = glossary.entries
    .filter((e) => e.treatment === "keep-english")
    .map((e) => {
      const aliases = Array.isArray(e.aliases) ? e.aliases : [];
      return `  - ${e.term}${e.aliases.length ? ` (also: ${e.aliases.join(", ")})` : ""}`;
    })
    .join("\n");

  return `
You are a professional Thai dubbing translator. Your translations feel like natural SPOKEN Thai, not subtitles.

Core principles (non-negotiable):
1. Translate for speech, not for reading. Natural Thai patterns only.
2. Match the speaker's register exactly (see PERSONA).
3. Preserve glossary terms in English — do not translate them.
4. Preserve [P] markers: the output must contain exactly the same number of [P] markers as the input, in corresponding positions.
5. Target the specified syllable count (±15%).
6. Drop pronouns when Thai speakers naturally would (often — ~70% of the time in casual speech).
7. Use sentence-final particles to match register naturally. Do NOT pepper every sentence with ครับ/ค่ะ — that sounds robotic.

PERSONA:
  Speaker: ${persona.speakerName}
  Gender: ${persona.gender}
  Channel type: ${persona.channelType}
  Register tier: ${persona.registerTier} — ${persona.registerDescription}
  Default pronouns to use: ${persona.defaultPronouns.join(", ")}
  Preferred particles: ${persona.preferredParticles.join(", ")}
  Notes: ${persona.notes}

GLOSSARY (keep these exactly in English — do not transliterate, do not translate):
${keepEnglishTerms || "  (none)"}

OUTPUT FORMAT: return ONLY valid JSON:
{
  "thai": "...",
  "pauseCount": N,
  "estimatedSyllables": N
}
`.trim();
}

export function buildTranslationUserPrompt(chunk: PreprocessedChunk): string {
  const prevBlock = chunk.prevChunkEn
    ? `PREVIOUS CHUNK (context only, do NOT re-translate):\n  EN: ${chunk.prevChunkEn}\n  TH: ${chunk.prevChunkTh ?? "[not translated yet]"}`
    : "PREVIOUS CHUNK: (this is the start of the video)";

  const nextBlock = chunk.nextChunkEn
    ? `UPCOMING CHUNK (context only, do NOT translate this now):\n  EN: ${chunk.nextChunkEn}`
    : "";

  return `
CONTEXT SO FAR:
${chunk.rollingSummary}

${prevBlock}

${nextBlock}

CURRENT CHUNK TO TRANSLATE:
EN: ${chunk.englishTextWithMarkers}

CONSTRAINTS:
- Pause markers in source: ${chunk.pauseCount} (output must contain the same count, in matching positions)
- Target syllables: ${chunk.targetSyllables} (acceptable range: ${chunk.minSyllables}–${chunk.maxSyllables})
- Wall-clock duration: ${chunk.endMs - chunk.startMs}ms

Translate now. Return ONLY the JSON object.
  `.trim();
}
