import OpenAI from "openai";
import { createReadStream, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import type { InputTranscript } from "../types.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — Whisper API hard limit

export async function transcribeWithWhisper(
  audioPath: string,
  videoId: string
): Promise<InputTranscript> {
  const fileSizeBytes = statSync(audioPath).size;
  if (fileSizeBytes > MAX_FILE_BYTES) {
    throw new Error(
      `Audio file is ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB — exceeds Whisper 25 MB limit. ` +
        `Split the audio first (see plan §6 gotchas).`
    );
  }

  const resp = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    // word-level timestamps needed later for pause marker injection (Stage 3.4)
    timestamp_granularities: ["segment", "word"],
    language: "en",
  });

  // Save raw response — word timestamps live here, needed in Stage 3
  const rawPath = join("output", videoId, "whisper.raw.json");
  writeFileSync(rawPath, JSON.stringify(resp, null, 2));

  const segments = resp.segments ?? [];

  return {
    source: "whisper",
    videoId,
    segments: segments.map((s, i) => ({
      segmentIndex: i,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      durationMs: Math.round((s.end - s.start) * 1000),
      englishText: s.text.trim(),
    })),
  };
}
