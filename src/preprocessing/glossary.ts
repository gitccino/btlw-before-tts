import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";
import "dotenv/config";
import type { Chunk, Glossary, GlossaryEntry } from "../types.js";
import { recordChat } from "../usage/tracker.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";

export async function buildGlossary(
  chunks: Chunk[],
  channelType: string,
): Promise<Glossary> {
  const fullText = chunks.map((c) => c.englishText).join(" ");
  const autoExtracted = await extractCandidateTerms(fullText, channelType);
  const userDefined = loadUserGlossary();
  return mergeGlossaries(autoExtracted, userDefined);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function extractCandidateTerms(
  fullText: string,
  channelType: string,
): Promise<Glossary> {
  const resp = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: "json_object" },
    temperature: 0.1,
    messages: [
      { role: "system", content: GLOSSARY_EXTRACTION_SYSTEM },
      {
        role: "user",
        content: `Channel type: ${channelType}\n\nTranscript:\n${fullText.slice(0, 6000)}`,
      },
    ],
  });

  recordChat("glossary", openaiModel, resp.usage);

  const parsed = JSON.parse(resp.choices[0].message.content!) as {
    entries?: unknown[];
  };

  const allowedTreatments = new Set<GlossaryEntry["treatment"]>([
    "keep-english",
    "translate",
    "transliterate",
  ]);

  const entries: GlossaryEntry[] = (
    Array.isArray(parsed.entries) ? parsed.entries : []
  ).flatMap((raw): GlossaryEntry[] => {
    if (!raw || typeof raw !== "object") return [];

    const entry = raw as Record<string, unknown>;
    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    if (!term) return [];

    const treatment = entry.treatment as GlossaryEntry["treatment"];
    if (!allowedTreatments.has(treatment)) {
      return [];
    }

    return [
      {
        term,
        aliases: Array.isArray(entry.aliases)
          ? entry.aliases
              .filter((alias): alias is string => typeof alias === "string")
              .map((alias) => alias.trim())
              .filter(Boolean)
          : [],
        treatment,
        thaiForm:
          typeof entry.thaiForm === "string"
            ? entry.thaiForm.trim()
            : undefined,
        notes: typeof entry.notes === "string" ? entry.notes.trim() : undefined,
      },
    ];
  });
  return { entries };
}

function loadUserGlossary(): Glossary {
  const path = "glossaries/default.json";
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf-8")) as Glossary;
}

// User-defined entries win over auto-extracted ones (same term → keep user's)
function mergeGlossaries(auto: Glossary, user: Glossary): Glossary {
  const merged = new Map<string, GlossaryEntry>();

  for (const entry of auto.entries) {
    merged.set(entry.term.toLowerCase(), entry);
  }
  for (const entry of user.entries) {
    merged.set(entry.term.toLowerCase(), entry); // user overrides auto
  }

  return { entries: Array.from(merged.values()) };
}

// ── prompt ────────────────────────────────────────────────────────────────────

const GLOSSARY_EXTRACTION_SYSTEM = `
You identify terms in an English transcript that should NOT be translated to Thai when dubbed, and terms that have standard Thai forms.

Categories of "keep-english" terms:
- Product/brand names (Adobe Photoshop, React, VS Code)
- Technical jargon used by the community in English (dissolve, feather, hydration)
- File formats, keyboard shortcuts (Ctrl-K, .png, CTRL-I)
- UI labels in English software (Import as Composition, New, Adjustment Layer)

Return ONLY valid JSON:
{
  "entries": [
    {
      "term": "After Effects",
      "aliases": ["AE"],
      "treatment": "keep-english",
      "notes": "Adobe product name"
    }
  ]
}

Be conservative — only flag terms you're confident should stay English. When in doubt, leave it out.
`.trim();
