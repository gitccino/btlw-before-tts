import pLimit from "p-limit";
import { resolve } from "node:path";
import type { Glossary, TranslatedChunk } from "../types.js";
import { refinePauses, fallbackTier } from "./pauseRefine.js";
import { prepareTtsInput } from "./textPrep.js";
import { synthesizeChunk, type SynthesizeResult } from "./synthesize.js";

const CONCURRENCY = 8;

export interface SynthesisReport {
  chunkIndex: number;
  wavPath: string;
  characters: number;
  usedMarkup: boolean;
  cached: boolean;
  pauseSource: "llm" | "fallback-gap" | "no-pauses";
  glossaryPatches: SynthesizeResult["glossaryPatches"];
}

export async function synthesizeAll(
  chunks: TranslatedChunk[],
  glossary: Glossary,
  outDir: string,
): Promise<SynthesisReport[]> {
  // Stage A — pause refinement (LLM pass, batched, cached).
  const refinedCachePath = resolve(outDir, "pauses.refined.json");
  const refined = await refinePauses(chunks, refinedCachePath);

  // Stage B — per-chunk synthesis with bounded concurrency.
  const limit = pLimit(CONCURRENCY);
  const reports: SynthesisReport[] = new Array(chunks.length);

  await Promise.all(
    chunks.map((chunk, index) =>
      limit(async () => {
        const rp = refined.get(index);
        const tieredText = rp?.tieredText ?? fallbackTier(chunk);
        const pauseSource: SynthesisReport["pauseSource"] =
          rp?.source ?? "fallback-gap";

        const input = prepareTtsInput(chunk, glossary, tieredText);

        let result: SynthesizeResult;
        try {
          result = await synthesizeChunk(index, input, outDir);
        } catch (err) {
          // Markup sometimes produces 400s on tricky strings — retry once as plain text.
          if (input.field === "markup") {
            const plain = prepareTtsInput(chunk, glossary, chunk.thaiText);
            console.warn(
              `[tts] chunk ${index} markup failed (${(err as Error).message}); retrying as plain text`,
            );
            result = await synthesizeChunk(index, plain, outDir);
          } else {
            throw err;
          }
        }

        reports[index] = {
          chunkIndex: index,
          wavPath: result.wavPath,
          characters: result.characters,
          usedMarkup: result.usedMarkup,
          cached: result.cached,
          pauseSource,
          glossaryPatches: result.glossaryPatches,
        };
      }),
    ),
  );

  return reports;
}
