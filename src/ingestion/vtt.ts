import { parse } from "node-webvtt";
import { readFileSync } from "node:fs";
import type { InputSegment, InputTranscript } from "../types.js";

export function parseVtt(path: string, videoId: string): InputTranscript {
  const raw = readFileSync(path, "utf-8");
  const { cues } = parse(raw, { meta: true });

  const segments: InputSegment[] = [];
  let lastText = "";

  for (const cue of cues) {
    // Strip inline tags: <c>, <v Speaker>, timestamps like <00:01.000>
    const text = cue.text.replace(/<[^>]+>/g, "").trim();

    // Skip blank cues and rolling duplicates
    if (!text || text === lastText) continue;

    segments.push({
      segmentIndex: segments.length,
      startMs: Math.round(cue.start * 1000),
      endMs: Math.round(cue.end * 1000),
      durationMs: Math.round((cue.end - cue.start) * 1000),
      englishText: text,
    });

    lastText = text;
  }

  return { source: "youtube-captions", videoId, segments };
}
