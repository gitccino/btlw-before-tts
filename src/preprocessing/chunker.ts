import type { InputSegment, Chunk } from "../types.js";

export interface ChunkerConfig {
  maxChunkDurationMs: number; // default 8000
  maxGapMs: number; // default 1500
}

const DEFAULT_CONFIG: ChunkerConfig = {
  maxChunkDurationMs: 8000,
  maxGapMs: 1500,
};

export function chunkSegments(
  segments: InputSegment[],
  config: ChunkerConfig = DEFAULT_CONFIG,
): Chunk[] {
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let current = startChunk(segments[0], 0);

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const gap = next.startMs - current.endMs;
    const combined = next.endMs - current.startMs;

    if (gap > config.maxGapMs || combined > config.maxChunkDurationMs) {
      // Natural boundary — seal current chunk, start fresh
      chunks.push(current);
      current = startChunk(next, chunks.length);
    } else {
      // Merge into current chunk
      current.endMs = next.endMs;
      current.englishText = `${current.englishText} ${next.englishText}`;
      current.sourceIndices.push(next.segmentIndex);
    }
  }

  chunks.push(current); // flush last chunk
  return chunks;
}

function startChunk(seg: InputSegment, chunkIndex: number): Chunk {
  return {
    chunkIndex,
    startMs: seg.startMs,
    endMs: seg.endMs,
    englishText: seg.englishText,
    sourceIndices: [seg.segmentIndex],
  };
}
