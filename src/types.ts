// Raw ASR / caption segment (from VTT or Whisper)
export interface InputSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  englishText: string;
}

export interface InputTranscript {
  source: "youtube-captions" | "whisper";
  videoId: string;
  segments: InputSegment[];
}

// After Stage 3.1 (chunking)
export interface Chunk {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  englishText: string;
  sourceIndices: number[]; // original ASR indices
}

// After Stage 3 (fully preprocessed)
export interface PreprocessedChunk extends Chunk {
  // From pause injection
  englishTextWithMarkers: string; // with [P] tokens
  pauseCount: number;
  pausePositions: number[]; // offsets in englishText
  pauseGapsMs: number[]; // original English gap (ms) per [P], length matches pauseCount; empty for VTT path

  // From duration budgeting
  targetSyllables: number; // acceptable range derived from this
  minSyllables: number; // ±15% typically
  maxSyllables: number;

  // From rolling context
  rollingSummary: string; // what's happened so far
  prevChunkEn?: string;
  prevChunkTh?: string; // filled after prev is translated
  nextChunkEn?: string;
}

// Persona pack — video-level, attached to every translation call
export interface PersonaPack {
  speakerName: string;
  gender: "male" | "female" | "unknown";
  channelType: string; // "tutorial" | "vlog" | "gaming" | ...
  targetAudience: string;
  registerTier: 1 | 2 | 3 | 4 | 5; // 1=formal, 4=casual, 5=crude
  registerDescription: string; // 1-2 sentences
  defaultPronouns: string[]; // e.g. ["ผม", "เรา"]
  preferredParticles: string[]; // e.g. ["ครับ", "นะครับ", "เลย"]
  notes: string; // free-form context
}

// Glossary — term → preferred treatment
export interface GlossaryEntry {
  term: string; // canonical English form
  aliases: string[]; // other ways the term appears
  treatment: "keep-english" | "translate" | "transliterate";
  thaiForm?: string; // if translate/transliterate
  notes?: string;
}

export interface Glossary {
  entries: GlossaryEntry[];
}

// Final output
export interface TranslatedChunk {
  startMs: number;
  endMs: number;
  englishText: string;
  thaiText: string; // clean for subtitles/markdown — [P] stripped
  thaiTextWithPauses: string; // retains raw [P] markers from translator; TTS input
  pauseGapsMs: number[]; // carried from PreprocessedChunk for downstream pause tiering
  thaiTextWithTieredPauses?: string; // set by the TTS pause-refinement pass: [P] → [pause short|pause|pause long]
}
