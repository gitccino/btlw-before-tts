import { writeFileSync, mkdirSync } from "node:fs";
import "dotenv/config";
import { ingest } from "./ingestion/youtube.js";
import { parseVtt } from "./ingestion/vtt.js";
import { transcribeWithWhisper } from "./transcription/whisper.js";
import { chunkSegments } from "./preprocessing/chunker.js";
import { extractPersona } from "./preprocessing/persona.js";
import { buildGlossary } from "./preprocessing/glossary.js";
import { preprocessAll } from "./preprocessing/index.js";
import { translateChunk } from "./translation/translate.js";
import { writeJson, writeMarkdown, writeSrt } from "./output/index.js";
import {
  writeTo as writeUsage,
  getTotals as getUsageTotals,
} from "./usage/tracker.js";
import type { TranslatedChunk } from "./types.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npx tsx src/cli.ts <youtube-url>");
  process.exit(1);
}

const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
console.log(`Using OpenAI model: ${openaiModel}`);

// ── Stage 1 — Ingest ──────────────────────────────────────────────────────────
console.log("Stage 1: ingesting...");
const ingested = await ingest(url);
const { videoId } = ingested;
const outDir = `output/${videoId}`;
mkdirSync(outDir, { recursive: true });
console.log(`  videoId: ${videoId}`);

// ── Stage 2 — Transcript ──────────────────────────────────────────────────────
console.log("Stage 2: acquiring transcript...");
const transcript = ingested.captionsPath
  ? parseVtt(ingested.captionsPath, videoId)
  : await transcribeWithWhisper(ingested.audioPath!, videoId);
writeFileSync(
  `${outDir}/transcript.en.json`,
  JSON.stringify(transcript, null, 2),
);
console.log(
  `  source: ${transcript.source}, segments: ${transcript.segments.length}`,
);

// ── Stage 3 — Preprocessing ───────────────────────────────────────────────────
console.log("Stage 3: preprocessing...");
const chunks = chunkSegments(transcript.segments);
console.log(`  chunks: ${chunks.length}`);

const persona = await extractPersona(ingested.metadata, chunks, videoId);
writeFileSync(`${outDir}/persona.json`, JSON.stringify(persona, null, 2));
console.log(`  persona: ${persona.speakerName} (tier ${persona.registerTier})`);

const glossary = await buildGlossary(chunks, persona.channelType);
writeFileSync(`${outDir}/glossary.json`, JSON.stringify(glossary, null, 2));
console.log(`  glossary: ${glossary.entries.length} entries`);

const preprocessed = await preprocessAll(chunks, persona, glossary, videoId);
writeFileSync(
  `${outDir}/preprocessed.json`,
  JSON.stringify(preprocessed, null, 2),
);
console.log(`  preprocessed: ${preprocessed.length} chunks`);

// ── Stage 4 — Translation (sequential — preserves prevChunkTh context) ────────
console.log("Stage 4: translating...");
const translated: TranslatedChunk[] = [];

for (const chunk of preprocessed) {
  if (translated.length > 0) {
    chunk.prevChunkTh = translated.at(-1)!.thaiText;
  }

  const thai = await translateChunk(chunk, persona, glossary);

  translated.push({
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    englishText: chunk.englishText,
    thaiText: thai.replace(/\s*\[P\]\s*/g, " ").trim(), // strip [P] markers from final output
  });

  process.stdout.write(
    `\r  translated: ${translated.length}/${preprocessed.length}`,
  );
}
console.log(); // newline after progress

// ── Stage 5 — Output ──────────────────────────────────────────────────────────
console.log("Stage 5: writing output...");
writeJson(`${outDir}/transcript.th.json`, translated);
writeMarkdown(`${outDir}/transcript.th.md`, translated);
writeSrt(`${outDir}/transcript.th.srt`, translated);

// ── Usage / cost tracker ──────────────────────────────────────────────────────
writeUsage(`${outDir}/usage.json`, openaiModel);
const totals = getUsageTotals();
const totalCalls = Object.values(totals.byStep).reduce(
  (n, s) => n + s.calls,
  0,
);
console.log(
  `  usage: $${totals.costUsd.toFixed(4)} across ${totalCalls} API calls ` +
    `(prompt ${totals.promptTokens}, cached ${totals.cachedTokens}, completion ${totals.completionTokens})`,
);

console.log(`\nDone. Output in ${outDir}/`);
console.log(`  ${outDir}/transcript.th.json  ← TTS input`);
console.log(`  ${outDir}/transcript.th.md    ← human review`);
console.log(`  ${outDir}/transcript.th.srt   ← subtitle player`);
console.log(`  ${outDir}/usage.json          ← token + cost tracker`);
