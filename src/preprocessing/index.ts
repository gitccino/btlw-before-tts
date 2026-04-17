import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Chunk,
  PreprocessedChunk,
  PersonaPack,
  Glossary,
} from "../types.js";
import { annotateDuration } from "./durationBudget.js";
import {
  injectPauseMarkersFromWords,
  injectPauseMarkersFromPunctuation,
  type WhisperWord,
} from "./pauseMarkers.js";
import { buildRollingContext } from "./context.js";

export async function preprocessAll(
  chunks: Chunk[],
  _persona: PersonaPack,
  _glossary: Glossary,
  videoId?: string,
): Promise<PreprocessedChunk[]> {
  // Load word-level timestamps if available (Whisper path)
  const words = loadWhisperWords(videoId);

  // Build rolling summaries for all chunks upfront
  const summaries = await buildRollingContext(chunks);

  return chunks.map((chunk, i) => {
    // 3.4 — pause markers
    const pauses = words
      ? injectPauseMarkersFromWords(chunk, words)
      : injectPauseMarkersFromPunctuation(chunk);

    // 3.5 — duration budget
    const budget = annotateDuration(chunk);

    // 3.6 — rolling context
    const rollingSummary = summaries.get(i) ?? "The video has just started.";
    const prevChunk = i > 0 ? chunks[i - 1] : undefined;
    const nextChunk = i < chunks.length - 1 ? chunks[i + 1] : undefined;

    return {
      ...chunk,
      englishTextWithMarkers: pauses.text,
      pauseCount: pauses.count,
      pausePositions: pauses.positions,
      targetSyllables: budget.targetSyllables,
      minSyllables: budget.minSyllables,
      maxSyllables: budget.maxSyllables,
      rollingSummary,
      prevChunkEn: prevChunk?.englishText,
      nextChunkEn: nextChunk?.englishText,
      // prevChunkTh filled during translation in Stage 4
    };
  });
}

function loadWhisperWords(videoId?: string): WhisperWord[] | null {
  if (!videoId) return null;
  const rawPath = join("output", videoId, "whisper.raw.json");
  if (!existsSync(rawPath)) return null;
  const raw = JSON.parse(readFileSync(rawPath, "utf-8")) as {
    words?: WhisperWord[];
  };
  return raw.words ?? null;
}
