import type { Chunk } from "../types.js";

export interface WhisperWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface PauseResult {
  text: string;
  count: number;
  positions: number[]; // char offsets in text where [P] was inserted
  gapsMs: number[]; // original English gap (ms) per [P]; length == count (empty if derived from punctuation)
}

// Whisper path — precise: use word-level timestamps from whisper.raw.json
export function injectPauseMarkersFromWords(
  chunk: Chunk,
  words: WhisperWord[],
  minPauseMs = 300,
): PauseResult {
  // Only words that fall within this chunk's time window
  const chunkWords = words.filter(
    (w) => w.start * 1000 >= chunk.startMs && w.end * 1000 <= chunk.endMs,
  );

  if (chunkWords.length === 0) {
    return { text: chunk.englishText, count: 0, positions: [], gapsMs: [] };
  }

  const parts: string[] = [];
  const positions: number[] = [];
  const gapsMs: number[] = [];

  for (let i = 0; i < chunkWords.length; i++) {
    parts.push(chunkWords[i].word);

    if (i < chunkWords.length - 1) {
      const gap = (chunkWords[i + 1].start - chunkWords[i].end) * 1000;
      if (gap >= minPauseMs) {
        parts.push("[P]");
        positions.push(parts.join(" ").length);
        gapsMs.push(Math.round(gap));
      }
    }
  }

  const text = parts.join(" ").replace(/\s+\[P\]/g, " [P]");
  return { text, count: positions.length, positions, gapsMs };
}

// VTT path — approximation: infer pauses from punctuation
export function injectPauseMarkersFromPunctuation(chunk: Chunk): PauseResult {
  const text = chunk.englishText
    .replace(/,\s+/g, ", [P] ") // comma pause
    .replace(/([.!?])\s+(?=[A-Z])/g, "$1 [P] "); // sentence boundary

  const count = (text.match(/\[P\]/g) ?? []).length;
  // positions + gapsMs not available without word timestamps
  return { text, count, positions: [], gapsMs: [] };
}
