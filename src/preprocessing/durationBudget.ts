import type { Chunk } from "../types.js";

// Casual Thai speech rate — used to estimate target syllable count per chunk
const THAI_SYLLABLES_PER_SECOND = 5;

export interface DurationBudget {
  targetSyllables: number;
  minSyllables: number; // target - 15%
  maxSyllables: number; // target + 15%
}

export function annotateDuration(chunk: Chunk): DurationBudget {
  const durationSec = (chunk.endMs - chunk.startMs) / 1000;
  const target = Math.round(durationSec * THAI_SYLLABLES_PER_SECOND);
  return {
    targetSyllables: target,
    minSyllables: Math.floor(target * 0.85),
    maxSyllables: Math.ceil(target * 1.15),
  };
}
