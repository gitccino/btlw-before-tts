import OpenAI from "openai";
import "dotenv/config";
import type { PreprocessedChunk, PersonaPack, Glossary } from "../types.js";
import {
  buildTranslationSystemPrompt,
  buildTranslationUserPrompt,
} from "./prompts.js";
import { countThaiSyllables } from "../util/thaiSyllables.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_ATTEMPTS = 3;

export async function translateChunk(
  chunk: PreprocessedChunk,
  persona: PersonaPack,
  glossary: Glossary,
  attempt = 1,
): Promise<string> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    temperature: attempt === 1 ? 0.4 : 0.6, // raise temperature on retry for variation
    messages: [
      {
        role: "system",
        content: buildTranslationSystemPrompt(persona, glossary),
      },
      { role: "user", content: buildTranslationUserPrompt(chunk) },
    ],
  });

  const parsed = JSON.parse(resp.choices[0].message.content!) as {
    thai: string;
    pauseCount: number;
    estimatedSyllables: number;
  };
  const thai = parsed.thai;

  // Validate pause count and syllable range
  const actualPauses = (thai.match(/\[P\]/g) ?? []).length;
  const actualSyllables = countThaiSyllables(thai);

  const pauseOk = actualPauses === chunk.pauseCount;
  const syllableOk =
    actualSyllables >= chunk.minSyllables &&
    actualSyllables <= chunk.maxSyllables;

  if (pauseOk && syllableOk) return thai;

  if (attempt >= MAX_ATTEMPTS) {
    console.warn(
      `Chunk ${chunk.chunkIndex}: giving up after ${MAX_ATTEMPTS} attempts. ` +
        `pauses ${actualPauses}/${chunk.pauseCount}, ` +
        `syllables ${actualSyllables} (need ${chunk.minSyllables}–${chunk.maxSyllables})`,
    );
    return thai; // return best effort
  }

  console.warn(
    `Chunk ${chunk.chunkIndex} retry ${attempt}: ` +
      `pauses ${actualPauses}/${chunk.pauseCount}, ` +
      `syllables ${actualSyllables} (need ${chunk.minSyllables}–${chunk.maxSyllables})`,
  );
  return translateChunk(chunk, persona, glossary, attempt + 1);
}
