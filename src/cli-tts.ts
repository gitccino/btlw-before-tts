import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { synthesizeAll } from "./tts/synthesizeAll.js";
import {
  writeTo as writeUsage,
  getTotals as getUsageTotals,
} from "./usage/tracker.js";
import type { Glossary, TranslatedChunk } from "./types.js";

const videoId = process.argv[2];
if (!videoId) {
  console.error("Usage: npx tsx src/cli-tts.ts <videoId>");
  process.exit(1);
}

const outDir = resolve("output", videoId);
if (!existsSync(outDir)) {
  console.error(`Output dir not found: ${outDir}`);
  process.exit(1);
}

const transcriptPath = resolve(outDir, "transcript.th.json");
if (!existsSync(transcriptPath)) {
  console.error(`Missing ${transcriptPath} — run the main pipeline first.`);
  process.exit(1);
}

const chunks = JSON.parse(
  readFileSync(transcriptPath, "utf-8"),
) as TranslatedChunk[];

// Back-compat: older transcripts may not have the pause fields. Fill sane defaults.
for (const c of chunks) {
  if (typeof c.thaiTextWithPauses !== "string") c.thaiTextWithPauses = c.thaiText;
  if (!Array.isArray(c.pauseGapsMs)) c.pauseGapsMs = [];
}

const glossaryPath = resolve(outDir, "glossary.json");
const glossary: Glossary = existsSync(glossaryPath)
  ? (JSON.parse(readFileSync(glossaryPath, "utf-8")) as Glossary)
  : { entries: [] };

mkdirSync(resolve(outDir, "tts"), { recursive: true });

console.log(`TTS: ${chunks.length} chunks → ${outDir}/tts/`);
console.log(`     voice: th-TH-Chirp3-HD-Achird @ 48kHz LINEAR16`);

const reports = await synthesizeAll(chunks, glossary, outDir);

const cached = reports.filter((r) => r.cached).length;
const synthesized = reports.length - cached;
const llmPauses = reports.filter((r) => r.pauseSource === "llm").length;
const fallbackPauses = reports.filter((r) => r.pauseSource === "fallback-gap").length;
const markup = reports.filter((r) => r.usedMarkup).length;
const patches = reports.reduce((n, r) => n + r.glossaryPatches.length, 0);

console.log(
  `     synthesized: ${synthesized}, cache hits: ${cached}, markup: ${markup}`,
);
console.log(
  `     pauses — llm: ${llmPauses}, gap-fallback: ${fallbackPauses}, no-pauses: ${reports.length - llmPauses - fallbackPauses}`,
);
if (patches > 0) console.log(`     glossary patches applied: ${patches}`);

writeUsage(resolve(outDir, "usage.json"), process.env.OPENAI_MODEL || "gpt-4.1-mini");
const totals = getUsageTotals();
console.log(
  `     usage so far: $${totals.costUsd.toFixed(4)} (TTS chars: ${totals.ttsCharacters})`,
);

console.log(`Done. WAVs in ${outDir}/tts/`);
