import OpenAI from "openai";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import "dotenv/config";
import type { TranslatedChunk } from "../types.js";
import { recordChat } from "../usage/tracker.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Batch size for the refinement pass. ~10 keeps prompts short enough to
// reason carefully about each chunk without blowing up output tokens.
const BATCH_SIZE = 10;

export interface RefinedPause {
  chunkIndex: number;
  // Same text as input's thaiTextWithPauses but each [P] has been replaced with
  // one of [pause short] / [pause] / [pause long]. If the model fails to
  // preserve count, the rule-based fallback is used instead.
  tieredText: string;
  source: "llm" | "fallback-gap" | "no-pauses";
}

type CacheFile = {
  model: string;
  generatedAt: string;
  items: Record<string, { inputHash: string; tieredText: string; source: RefinedPause["source"] }>;
};

export async function refinePauses(
  chunks: TranslatedChunk[],
  cachePath: string,
): Promise<Map<number, RefinedPause>> {
  const cache = loadCache(cachePath);
  const out = new Map<number, RefinedPause>();
  const toProcess: Array<{ index: number; chunk: TranslatedChunk }> = [];

  // First pass: serve from cache where inputHash matches; collect the rest.
  chunks.forEach((chunk, index) => {
    const inputHash = hashInput(chunk);

    if (!/\[P\]/.test(chunk.thaiTextWithPauses)) {
      out.set(index, {
        chunkIndex: index,
        tieredText: chunk.thaiTextWithPauses,
        source: "no-pauses",
      });
      return;
    }

    const cached = cache.items[String(index)];
    if (cached && cached.inputHash === inputHash) {
      out.set(index, {
        chunkIndex: index,
        tieredText: cached.tieredText,
        source: cached.source,
      });
      return;
    }

    toProcess.push({ index, chunk });
  });

  // Second pass: batch-refine the uncached chunks.
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const refined = await refineBatch(batch);
    for (const item of refined) {
      out.set(item.chunkIndex, item);
      cache.items[String(item.chunkIndex)] = {
        inputHash: hashInput(batch.find((b) => b.index === item.chunkIndex)!.chunk),
        tieredText: item.tieredText,
        source: item.source,
      };
    }
  }

  if (toProcess.length > 0) {
    saveCache(cachePath, cache);
  }

  return out;
}

async function refineBatch(
  batch: Array<{ index: number; chunk: TranslatedChunk }>,
): Promise<RefinedPause[]> {
  const userPayload = batch.map(({ index, chunk }) => ({
    chunkIndex: index,
    thaiText: chunk.thaiTextWithPauses,
    pauseGapsMs: chunk.pauseGapsMs,
    expectedPauseCount: (chunk.thaiTextWithPauses.match(/\[P\]/g) ?? []).length,
  }));

  const resp = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: REFINE_SYSTEM },
      {
        role: "user",
        content: `Refine the following chunks. Return ONLY valid JSON of the form:\n{ "items": [{ "chunkIndex": N, "tieredText": "..." }] }\n\nCHUNKS:\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  recordChat("tts-pause-refine", openaiModel, resp.usage);

  const content = resp.choices[0].message.content ?? "{}";
  let parsed: { items?: Array<{ chunkIndex?: number; tieredText?: string }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn("[pauseRefine] LLM returned invalid JSON; using gap-ms fallback for batch");
    return batch.map(({ index, chunk }) => ({
      chunkIndex: index,
      tieredText: fallbackTier(chunk),
      source: "fallback-gap" as const,
    }));
  }

  const byIndex = new Map<number, string>();
  for (const item of parsed.items ?? []) {
    if (typeof item.chunkIndex === "number" && typeof item.tieredText === "string") {
      byIndex.set(item.chunkIndex, item.tieredText);
    }
  }

  return batch.map(({ index, chunk }) => {
    const tiered = byIndex.get(index);
    if (tiered && tieredCountMatches(chunk.thaiTextWithPauses, tiered)) {
      return { chunkIndex: index, tieredText: tiered, source: "llm" as const };
    }
    return {
      chunkIndex: index,
      tieredText: fallbackTier(chunk),
      source: "fallback-gap" as const,
    };
  });
}

// Count of [pause*] tokens in refined text must equal [P] count in input.
function tieredCountMatches(input: string, refined: string): boolean {
  const expected = (input.match(/\[P\]/g) ?? []).length;
  const actual = (refined.match(/\[pause(?:\s+short|\s+long)?\]/g) ?? []).length;
  return expected === actual;
}

// Rule-based fallback: tier by source gap duration only.
export function fallbackTier(chunk: TranslatedChunk): string {
  const gaps = chunk.pauseGapsMs;
  let gapIdx = 0;
  return chunk.thaiTextWithPauses.replace(/\[P\]/g, () => {
    const gap = gaps[gapIdx++] ?? 600; // default = medium
    if (gap < 500) return "[pause short]";
    if (gap > 1000) return "[pause long]";
    return "[pause]";
  });
}

// ── caching ───────────────────────────────────────────────────────────────────

function hashInput(chunk: TranslatedChunk): string {
  const payload = JSON.stringify({
    thaiTextWithPauses: chunk.thaiTextWithPauses,
    pauseGapsMs: chunk.pauseGapsMs,
    model: openaiModel,
  });
  return djb2(payload);
}

function djb2(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function loadCache(path: string): CacheFile {
  if (!existsSync(path)) {
    return {
      model: openaiModel,
      generatedAt: new Date().toISOString(),
      items: {},
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CacheFile>;
    return {
      model: raw.model ?? openaiModel,
      generatedAt: raw.generatedAt ?? new Date().toISOString(),
      items: raw.items ?? {},
    };
  } catch {
    return {
      model: openaiModel,
      generatedAt: new Date().toISOString(),
      items: {},
    };
  }
}

function saveCache(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  cache.generatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

// ── prompt ────────────────────────────────────────────────────────────────────

const REFINE_SYSTEM = `
You are a Thai prosody specialist for a Thai dubbing pipeline.

INPUT: an array of chunks. Each chunk has Thai dubbing text with [P] markers and the source English gap duration (ms) at each [P].

TASK: for every [P] in each chunk, replace it with one of:
  - [pause short]   — very brief breath, mid-clause
  - [pause]         — natural clause boundary
  - [pause long]    — topic/sentence boundary

DECIDE USING:
  1. The Thai text around the marker (primary signal):
     - Before a sentence-final particle (ครับ/ค่ะ/นะ/แหละ/เลย/ไง) at end of clause → [pause long] or [pause]
     - Before a topic shift or new sentence (starting with "แล้ว", "แต่", "พอ", etc.) → [pause long] or [pause]
     - Before/after a short connector mid-phrase (ก็, คือ, หรือ, ที่) → [pause short]
     - Between two closely-linked noun phrases (comma-like) → [pause short]
  2. The source English gap duration (secondary signal):
     - < 500 ms tends to indicate [pause short]
     - 500–1000 ms tends to indicate [pause]
     - > 1000 ms tends to indicate [pause long]
  Use BOTH signals. The Thai context takes precedence when they disagree.

HARD CONSTRAINTS:
  - Preserve the exact Thai text, character for character, except that each [P] becomes exactly one of [pause short] / [pause] / [pause long].
  - The count of pause markers must equal the input count of [P] markers (expectedPauseCount).
  - Do NOT add new pauses, remove pauses, or change their order.
  - Do NOT modify any Latin-script (English) words that appear in the Thai text; leave them exactly as-is.
  - Return ONLY valid JSON: { "items": [{ "chunkIndex": number, "tieredText": string }, ...] }.
`.trim();
