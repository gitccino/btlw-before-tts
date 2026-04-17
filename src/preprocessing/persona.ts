import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import type { Chunk, PersonaPack } from "../types.js";
import type { IngestResult } from "../ingestion/youtube.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractPersona(
  metadata: IngestResult["metadata"],
  chunks: Chunk[],
  videoId?: string
): Promise<PersonaPack> {
  // Escape hatch: manual override wins over auto-extraction
  if (videoId) {
    const overridePath = join("personas", `${videoId}.json`);
    if (existsSync(overridePath)) {
      return JSON.parse(readFileSync(overridePath, "utf-8")) as PersonaPack;
    }
  }

  const firstMinute = chunks
    .filter((c) => c.startMs < 60_000)
    .map((c) => c.englishText)
    .join(" ");

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: PERSONA_EXTRACTION_SYSTEM },
      { role: "user", content: buildPersonaPrompt(metadata, firstMinute) },
    ],
  });

  return JSON.parse(resp.choices[0].message.content!) as PersonaPack;
}

// ── prompts ───────────────────────────────────────────────────────────────────

const PERSONA_EXTRACTION_SYSTEM = `
You analyze YouTube videos to build a "persona pack" that will guide a Thai translator dubbing the video.

Thai has five register tiers:
  1 = very formal (news anchor, royal speech)
  2 = polite (talking to strangers, customer service)
  3 = neutral (default LLM output, feels like subtitles)
  4 = casual (most YouTube creators — friendly, informal)
  5 = crude or intimate (close friends, gaming, arguments)

Tier 3 is almost always wrong for YouTube. Pick 2 or 4 unless you have a strong reason.

Return ONLY valid JSON with these fields:
{
  "speakerName": string,
  "gender": "male" | "female" | "unknown",
  "channelType": string,
  "targetAudience": string,
  "registerTier": 2 | 4,
  "registerDescription": string,
  "defaultPronouns": string[],
  "preferredParticles": string[],
  "notes": string
}
`.trim();

function buildPersonaPrompt(
  metadata: { title: string; description: string; channel: string },
  firstMinute: string
): string {
  return `
Video metadata:
- Title: ${metadata.title}
- Channel: ${metadata.channel}
- Description: ${metadata.description.slice(0, 500)}

First minute of transcript:
${firstMinute}

Build the persona pack.
  `.trim();
}
