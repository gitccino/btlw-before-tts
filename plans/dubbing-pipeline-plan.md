# EN→TH YouTube Dubbing Transcript Pipeline — Implementation Plan

**Goal:** YouTube URL → time-aligned Thai transcript that, when fed to TTS, produces dubbing-quality output noticeably better than dumping the full transcript into `gpt-4.1-mini` directly.

**Why this will beat vanilla `gpt-4.1-mini`:** the model is capable; the failure mode is *lack of context*. Preprocessing feeds the model everything a human translator would ask for before starting — speaker persona, register tier, glossary, pause structure, duration budget, and surrounding chunks. Each item below is a concrete preprocessing step whose contribution can be A/B tested in isolation.

---

## 1. Architecture Overview

```
┌─────────────┐
│ YouTube URL │
└──────┬──────┘
       │
       ▼
┌───────────────────────────────────────────────────────┐
│ Stage 1 — Ingestion (yt-dlp)                          │
│   • Fetch metadata (title, description, channel)      │
│   • Try manual EN captions (.vtt)                     │
│   • Fallback: download audio (.m4a/.opus)             │
└──────┬────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────┐
│ Stage 2 — Transcript acquisition                      │
│   Path A (captions found): parse VTT → segments       │
│   Path B (no captions): Whisper API → segments        │
│   Output: InputSegment[] (startMs, endMs, text)       │
└──────┬────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────┐
│ Stage 3 — Preprocessing (the differentiator)          │
│   3.1  Chunking (greedy merge, ≤8s wall clock)        │
│   3.2  Persona pack extraction (metadata + opening)   │
│   3.3  Glossary building (NER + overrides)            │
│   3.4  Pause marker injection ([P] tokens)            │
│   3.5  Duration budget annotation (target syllables)  │
│   3.6  Rolling context assembly (summary + neighbors) │
│   Output: PreprocessedChunk[]                         │
└──────┬────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────┐
│ Stage 4 — Translation (gpt-4.1-mini)                  │
│   • Per-chunk call with full preprocessing context    │
│   • JSON-mode output for validation                   │
│   • Retry on pause-count / syllable-budget failure    │
└──────┬────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────┐
│ Stage 5 — Output                                      │
│   • transcript.th.json  (structured, for TTS)         │
│   • transcript.th.md    (human-readable)              │
│   • transcript.th.srt   (subtitle-compatible)         │
└───────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Node.js 20+ / TypeScript | Your stack; strong OpenAI SDK |
| Runner | `tsx` | Fast dev loop, no build step |
| YouTube | `yt-dlp` via `child_process` | Most reliable; handles captions + audio + metadata in one CLI |
| VTT parsing | `node-webvtt` or hand-rolled | VTT format is simple |
| Whisper | `openai` SDK (`whisper-1`) | Per your spec |
| Translation | `openai` SDK (`gpt-4.1-mini`) | Per your spec |
| Thai tokenization | `@pithee/thai-segmenter` or heuristic | For syllable counting |
| Audio (optional) | `fluent-ffmpeg` | Only if you need re-encoding before Whisper |

**Install:**
```bash
npm i openai node-webvtt
npm i -D tsx typescript @types/node
# System dep: yt-dlp must be on PATH
brew install yt-dlp          # macOS
# or: pip install yt-dlp
```

---

## 3. Project Structure

```
dubbing-pipeline/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts                  # All shared type definitions
│   ├── ingestion/
│   │   ├── youtube.ts            # yt-dlp wrapper
│   │   └── vtt.ts                # VTT → InputSegment[]
│   ├── transcription/
│   │   └── whisper.ts            # Whisper API wrapper
│   ├── preprocessing/
│   │   ├── chunker.ts            # Greedy chunk merger
│   │   ├── persona.ts            # Persona pack extraction
│   │   ├── glossary.ts           # Glossary extraction
│   │   ├── pauseMarkers.ts       # [P] injection
│   │   ├── durationBudget.ts     # Thai syllable estimation
│   │   └── context.ts            # Rolling summary + neighbors
│   ├── translation/
│   │   ├── translate.ts          # gpt-4.1-mini translator
│   │   └── prompts.ts            # System + user prompt templates
│   ├── output/
│   │   ├── writeJson.ts
│   │   ├── writeMarkdown.ts
│   │   └── writeSrt.ts
│   ├── util/
│   │   ├── time.ts               # ms ↔ SRT/VTT timestamp helpers
│   │   └── thaiSyllables.ts      # Rough syllable counter
│   └── cli.ts                    # Entry point
├── personas/                     # Optional manual overrides
│   └── default.json
├── glossaries/
│   └── default.json
└── output/
    └── {videoId}/
        ├── metadata.json
        ├── captions.en.vtt
        ├── audio.m4a              # only if Whisper path
        ├── transcript.en.json
        ├── persona.json
        ├── glossary.json
        ├── preprocessed.json      # debug: chunks + all annotations
        ├── transcript.th.json
        ├── transcript.th.md
        └── transcript.th.srt
```

**Rule:** every stage writes its output to disk. This makes debugging trivial — you can rerun any stage without redoing the prior ones.

---

## 4. Core Data Types

Put these in `src/types.ts`. Every stage reads and writes one of these.

```ts
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
  sourceIndices: number[];   // original ASR indices
}

// After Stage 3 (fully preprocessed)
export interface PreprocessedChunk extends Chunk {
  // From pause injection
  englishTextWithMarkers: string;  // with [P] tokens
  pauseCount: number;
  pausePositions: number[];        // offsets in englishText

  // From duration budgeting
  targetSyllables: number;         // acceptable range derived from this
  minSyllables: number;            // ±15% typically
  maxSyllables: number;

  // From rolling context
  rollingSummary: string;          // what's happened so far
  prevChunkEn?: string;
  prevChunkTh?: string;            // filled after prev is translated
  nextChunkEn?: string;
}

// Persona pack — video-level, attached to every translation call
export interface PersonaPack {
  speakerName: string;
  gender: "male" | "female" | "unknown";
  channelType: string;             // "tutorial" | "vlog" | "gaming" | ...
  targetAudience: string;
  registerTier: 1 | 2 | 3 | 4 | 5; // 1=formal, 4=casual, 5=crude
  registerDescription: string;     // 1-2 sentences
  defaultPronouns: string[];       // e.g. ["ผม", "เรา"]
  preferredParticles: string[];    // e.g. ["ครับ", "นะครับ", "เลย"]
  notes: string;                   // free-form context
}

// Glossary — term → preferred treatment
export interface GlossaryEntry {
  term: string;                    // canonical English form
  aliases: string[];               // other ways the term appears
  treatment: "keep-english" | "translate" | "transliterate";
  thaiForm?: string;               // if translate/transliterate
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
  thaiText: string;
}
```

---

## 5. Stage 1 — YouTube Ingestion

**Input:** YouTube URL
**Output:** metadata + (captions VTT path) or (audio file path)

### Approach

Single `yt-dlp` call with flags that do everything in one pass. Three outcomes: manual EN captions found, only auto-generated captions available, or no captions at all.

**Critical rule per your spec:** never use auto-generated captions. They are lossier than Whisper. Treat "only auto-generated available" identically to "no captions."

### Commands

```bash
# Probe: get metadata + list available captions without downloading
yt-dlp --skip-download --write-info-json -o "output/%(id)s/%(id)s" "$URL"

# If manual EN subs exist, this downloads them:
yt-dlp --skip-download --write-sub --sub-lang en --sub-format vtt \
       -o "output/%(id)s/%(id)s" "$URL"

# Fallback: download audio for Whisper
yt-dlp -x --audio-format m4a -o "output/%(id)s/audio.%(ext)s" "$URL"
```

### Implementation sketch

```ts
// src/ingestion/youtube.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface IngestResult {
  videoId: string;
  metadata: {
    title: string;
    description: string;
    channel: string;
    durationSec: number;
    uploadDate: string;
  };
  captionsPath: string | null;  // null if none or auto-only
  audioPath: string | null;     // set if we had to fall back
}

export async function ingest(url: string): Promise<IngestResult> {
  // 1. Fetch info JSON
  const info = await fetchInfoJson(url);
  const videoId = info.id;

  // 2. Check for MANUAL English subs only
  const hasManualEn = info.subtitles?.en !== undefined;

  // 3. Either download captions OR audio
  const captionsPath = hasManualEn ? await downloadCaptions(url, videoId) : null;
  const audioPath = captionsPath === null ? await downloadAudio(url, videoId) : null;

  return { videoId, metadata: extractMetadata(info), captionsPath, audioPath };
}
```

### Gotchas

- `info.subtitles` holds **manual** captions; `info.automatic_captions` holds auto-generated. Check only the former.
- VTT files can have duplicate lines (YouTube's rolling subtitle trick). Parser must dedupe.
- Videos may be age-restricted or geo-blocked — surface these errors clearly.
- `yt-dlp` is a moving target; pin a version in your deploy.

---

## 6. Stage 2 — Transcript Acquisition

**Input:** VTT file path OR audio file path
**Output:** `InputTranscript` (unified segment array)

### Path A — Parse VTT

YouTube manual captions tend to be well-punctuated and speaker-aware. But they're often split into small cues (1–3 seconds each) and have rolling duplicates.

```ts
// src/ingestion/vtt.ts
import { parse } from "node-webvtt";
import { readFileSync } from "node:fs";
import type { InputSegment, InputTranscript } from "../types.ts";

export function parseVtt(path: string, videoId: string): InputTranscript {
  const raw = readFileSync(path, "utf-8");
  const { cues } = parse(raw, { meta: true });

  const segments: InputSegment[] = [];
  let lastText = "";

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cue.text.replace(/<[^>]+>/g, "").trim(); // strip inline tags
    if (!text || text === lastText) continue;             // dedupe rolling
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
```

### Path B — Whisper

```ts
// src/transcription/whisper.ts
import OpenAI from "openai";
import { createReadStream } from "node:fs";
import type { InputTranscript } from "../types.ts";

const openai = new OpenAI();

export async function transcribeWithWhisper(
  audioPath: string,
  videoId: string,
): Promise<InputTranscript> {
  const resp = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"], // word-level enables pause detection
    language: "en",
  });

  return {
    source: "whisper",
    videoId,
    segments: resp.segments.map((s, i) => ({
      segmentIndex: i,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      durationMs: Math.round((s.end - s.start) * 1000),
      englishText: s.text.trim(),
    })),
  };
}
```

### Why word-level timestamps matter

`timestamp_granularities: ["word"]` costs nothing extra and gives you per-word offsets. You need these for Stage 3.4 (pause marker injection). Save them alongside the transcript:

```ts
// Store raw response too
writeFileSync(`output/${videoId}/whisper.raw.json`, JSON.stringify(resp, null, 2));
```

### Gotchas

- Whisper has a 25 MB file size limit. For videos >~30 min you must split. Use ffmpeg to cut on silence, keep timestamp offsets.
- VTT `<c>` and `<v>` inline tags break naive parsers — strip them.
- Whisper occasionally hallucinates on long silences. Post-filter segments whose text is just "Thanks for watching" / "♪" / repeated phrases.

---

## 7. Stage 3 — Preprocessing (The Differentiator)

This is where your pipeline's quality advantage lives. Each subsection is one preprocessing function that takes `Chunk[]` + some context and enriches it. The final artifact is `PreprocessedChunk[]`.

### 3.1 Chunking

**What:** merge adjacent ASR segments into translation-ready units. A chunk is what gets translated in one LLM call.

**Why:** 1-sentence chunks lose context; whole-video chunks blow token budgets and smear register. Sweet spot is 5–8 seconds of wall-clock audio per chunk.

**Algorithm:** greedy left-to-right merge, break on either constraint:
- Combined wall-clock duration > 8000ms
- Gap between current and next segment > 1500ms (natural pause → natural boundary)

```ts
// src/preprocessing/chunker.ts
export interface ChunkerConfig {
  maxChunkDurationMs: number; // default 8000
  maxGapMs: number;           // default 1500
}

export function chunkSegments(
  segments: InputSegment[],
  config: ChunkerConfig = { maxChunkDurationMs: 8000, maxGapMs: 1500 },
): Chunk[] {
  if (segments.length === 0) return [];
  const chunks: Chunk[] = [];
  let current = startChunk(segments[0], 0);

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const gap = next.startMs - current.endMs;
    const combined = next.endMs - current.startMs;

    if (gap > config.maxGapMs || combined > config.maxChunkDurationMs) {
      chunks.push(current);
      current = startChunk(next, chunks.length);
    } else {
      current.endMs = next.endMs;
      current.englishText = `${current.englishText} ${next.englishText}`;
      current.sourceIndices.push(next.segmentIndex);
    }
  }
  chunks.push(current);
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
```

### 3.2 Persona Pack Extraction

**What:** build a `PersonaPack` that describes *who* is speaking and *how*. This becomes part of the system prompt for every translation call.

**Why:** without this, gpt-4.1-mini defaults to Tier 3 neutral Thai (safe, stiff, subtitle-like). With it, the model matches the actual speech register.

**How:** call gpt-4.1-mini *once* with the video title, description, channel name, and the first 60 seconds of transcript. Ask it to return a structured PersonaPack.

```ts
// src/preprocessing/persona.ts
export async function extractPersona(
  metadata: IngestResult["metadata"],
  chunks: Chunk[],
): Promise<PersonaPack> {
  const firstMinute = chunks
    .filter(c => c.startMs < 60_000)
    .map(c => c.englishText)
    .join(" ");

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: PERSONA_EXTRACTION_SYSTEM },
      { role: "user", content: buildPersonaPrompt(metadata, firstMinute) },
    ],
  });

  return JSON.parse(resp.choices[0].message.content!);
}
```

**Prompt** (in `src/translation/prompts.ts`):

```ts
export const PERSONA_EXTRACTION_SYSTEM = `
You analyze YouTube videos to build a "persona pack" that will guide a Thai translator dubbing the video.

Thai has five register tiers:
  1 = very formal (news anchor, royal speech)
  2 = polite (talking to strangers, customer service)
  3 = neutral (default LLM output, feels like subtitles)
  4 = casual (most YouTube creators — friendly, informal)
  5 = crude or intimate (close friends, gaming, arguments)

Tier 3 is almost always wrong for YouTube. Pick 2 or 4 unless you have a strong reason.

Return ONLY valid JSON with these fields:
{
  "speakerName": string,
  "gender": "male" | "female" | "unknown",
  "channelType": string,
  "targetAudience": string,
  "registerTier": 2 | 4,
  "registerDescription": string,
  "defaultPronouns": string[],     // Thai pronouns, e.g. ["ผม", "เรา"]
  "preferredParticles": string[],  // Thai particles, e.g. ["ครับ", "นะครับ", "เลย"]
  "notes": string
}
`.trim();

export function buildPersonaPrompt(
  metadata: { title: string; description: string; channel: string },
  firstMinute: string,
): string {
  return `
Video metadata:
- Title: ${metadata.title}
- Channel: ${metadata.channel}
- Description: ${metadata.description.slice(0, 500)}

First minute of transcript:
${firstMinute}

Build the persona pack.
  `.trim();
}
```

**Escape hatch:** always allow the user to override via `personas/{videoId}.json` or a CLI flag. Auto-extraction is fallback, not truth.

### 3.3 Glossary Building

**What:** identify terms that should stay in English (product names, technical jargon, file formats, keyboard shortcuts) and terms with preferred Thai forms.

**Why:** in tech tutorials, "After Effects" dubbed as "อาฟเตอร์เอฟเฟกต์" sounds absurd. Gaming videos leave "GG", "kill", "lane" in English. The reference file for Ben Marriott's tutorial leaves `dissolve`, `feather`, `mask`, `composition`, `Ctrl-K` in English throughout.

**How:** two-pass approach.
1. Extract candidate terms via a quick LLM call (prompt below).
2. Merge with a user-maintained list in `glossaries/default.json` and per-video overrides.

```ts
// src/preprocessing/glossary.ts
export async function buildGlossary(
  chunks: Chunk[],
  channelType: string,
): Promise<Glossary> {
  const fullText = chunks.map(c => c.englishText).join(" ");
  const autoExtracted = await extractCandidateTerms(fullText, channelType);
  const userDefined = loadUserGlossary(); // from glossaries/default.json
  return mergeGlossaries(autoExtracted, userDefined);
}
```

**Extraction prompt:**

```ts
export const GLOSSARY_EXTRACTION_SYSTEM = `
You identify terms in an English transcript that should NOT be translated to Thai when dubbed, and terms that have standard Thai forms.

Categories of "keep-english" terms:
- Product/brand names (Adobe Photoshop, React, VS Code)
- Technical jargon used by the community in English (dissolve, feather, hydration)
- File formats, keyboard shortcuts (Ctrl-K, .png, CTRL-I)
- UI labels in English software (Import as Composition, New, Adjustment Layer)

Return ONLY valid JSON:
{
  "entries": [
    {
      "term": "After Effects",
      "aliases": ["AE"],
      "treatment": "keep-english",
      "notes": "Adobe product name"
    },
    ...
  ]
}

Be conservative — only flag terms you're confident should stay English. When in doubt, leave it out.
`.trim();
```

### 3.4 Pause Marker Injection

**What:** insert `[P]` tokens into each chunk's English text at positions where the speaker paused ≥300ms. The translator is instructed to preserve the same number of markers in corresponding positions.

**Why:** this is the single cheapest prosody technique and it works. Pause positions in the target dub matching the source is what makes mouth movements and gestures land naturally.

**How:** use word-level timestamps (Whisper path) or approximate from punctuation (VTT path).

```ts
// src/preprocessing/pauseMarkers.ts

// Whisper path: use word-level timestamps
export function injectPauseMarkersFromWords(
  chunk: Chunk,
  words: WhisperWord[],
  minPauseMs = 300,
): { text: string; count: number; positions: number[] } {
  const chunkWords = words.filter(
    w => w.start * 1000 >= chunk.startMs && w.end * 1000 <= chunk.endMs
  );

  const parts: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < chunkWords.length; i++) {
    parts.push(chunkWords[i].word);
    if (i < chunkWords.length - 1) {
      const gap = (chunkWords[i + 1].start - chunkWords[i].end) * 1000;
      if (gap >= minPauseMs) {
        parts.push("[P]");
        positions.push(parts.join(" ").length);
      }
    }
  }
  const text = parts.join(" ").replace(/\s+\[P\]/g, " [P]");
  return { text, count: positions.length, positions };
}

// VTT path: fallback using commas and sentence breaks
export function injectPauseMarkersFromPunctuation(chunk: Chunk) {
  // Comma or sentence boundary → [P]
  const text = chunk.englishText
    .replace(/,\s+/g, ", [P] ")
    .replace(/([.!?])\s+(?=[A-Z])/g, "$1 [P] ");
  const count = (text.match(/\[P\]/g) ?? []).length;
  return { text, count, positions: [] };
}
```

### 3.5 Duration Budget Annotation

**What:** estimate how many Thai syllables the translation should produce to fit the chunk's wall-clock duration.

**Why:** telling the model "translate this to Thai" is different from "translate this into roughly 14 Thai syllables." The latter produces tighter, more speakable output.

**Formula:**
- Casual Thai speech ≈ 5 syllables per second
- Chunk duration in seconds × 5 = target syllables
- Acceptable range: ±15%

```ts
// src/preprocessing/durationBudget.ts
const THAI_SYLLABLES_PER_SECOND = 5;

export function annotateDuration(chunk: Chunk) {
  const durationSec = (chunk.endMs - chunk.startMs) / 1000;
  const target = Math.round(durationSec * THAI_SYLLABLES_PER_SECOND);
  return {
    targetSyllables: target,
    minSyllables: Math.floor(target * 0.85),
    maxSyllables: Math.ceil(target * 1.15),
  };
}
```

**Syllable counting for validation** (rough heuristic — every Thai vowel cluster counts as one syllable, filter out punctuation and Latin terms):

```ts
// src/util/thaiSyllables.ts
export function countThaiSyllables(text: string): number {
  // Strip Latin-script glossary terms (they count differently)
  const thaiOnly = text.replace(/[A-Za-z0-9_\-.]+/g, "");
  // Rough: Thai syllable roughly = consonant + vowel cluster
  // This matches on Thai consonants (U+0E01-U+0E2E)
  const consonants = thaiOnly.match(/[\u0E01-\u0E2E]/g) ?? [];
  return consonants.length; // approximation; good enough for ±15% validation
}
```

For production, replace with a real Thai tokenizer. The heuristic above is fine for the MVP validation loop.

### 3.6 Rolling Context Assembly

**What:** for each chunk, attach three context fields before translation:
- `rollingSummary` — 2-3 sentences describing what the video has covered so far
- `prevChunkEn` / `prevChunkTh` — the immediately previous chunk and its translation
- `nextChunkEn` — the upcoming chunk (not translated yet) for forward disambiguation

**Why:** resolves pronouns, maintains topic continuity, and keeps register stable. Without this, gpt-4.1-mini translates each chunk in isolation, which is exactly the "feels like subtitles" failure mode.

**How:** maintain a rolling summary that you regenerate every N chunks (every 5 is a reasonable default). Cheap because gpt-4.1-mini summarization is fast.

```ts
// src/preprocessing/context.ts
export async function buildRollingContext(
  chunks: Chunk[],
  summaryEveryN = 5,
): Promise<Map<number, string>> {
  // Map chunkIndex → rollingSummary that applies to it
  const summaries = new Map<number, string>();
  let currentSummary = "The video has just started.";

  for (let i = 0; i < chunks.length; i++) {
    summaries.set(i, currentSummary);
    if (i > 0 && i % summaryEveryN === 0) {
      currentSummary = await summarizeUpTo(chunks.slice(0, i + 1));
    }
  }
  return summaries;
}

async function summarizeUpTo(chunksSoFar: Chunk[]): Promise<string> {
  const text = chunksSoFar.map(c => c.englishText).join(" ");
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: "Summarize what has been covered in this YouTube video so far in 2-3 sentences. Focus on topic, who/what is involved, and tone. This summary will help a translator maintain context.",
      },
      { role: "user", content: text },
    ],
  });
  return resp.choices[0].message.content!.trim();
}
```

---

## 8. Stage 4 — Translation

**Input:** `PreprocessedChunk[]` + `PersonaPack` + `Glossary`
**Output:** `TranslatedChunk[]`

### Translation prompts

**System prompt** — constructed once, reused for every chunk:

```ts
// src/translation/prompts.ts
export function buildTranslationSystemPrompt(
  persona: PersonaPack,
  glossary: Glossary,
): string {
  const keepEnglishTerms = glossary.entries
    .filter(e => e.treatment === "keep-english")
    .map(e => `  - ${e.term}${e.aliases.length ? ` (also: ${e.aliases.join(", ")})` : ""}`)
    .join("\n");

  return `
You are a professional Thai dubbing translator. Your translations feel like natural SPOKEN Thai, not subtitles.

Core principles (non-negotiable):
1. Translate for speech, not for reading. Natural Thai patterns only.
2. Match the speaker's register exactly (see PERSONA).
3. Preserve glossary terms in English — do not translate them.
4. Preserve [P] markers: the output must contain exactly the same number of [P] markers as the input, in corresponding positions.
5. Target the specified syllable count (±15%).
6. Drop pronouns when Thai speakers naturally would (often — ~70% of the time in casual speech).
7. Use sentence-final particles to match register naturally. Do NOT pepper every sentence with ครับ/ค่ะ — that sounds robotic.

PERSONA:
  Speaker: ${persona.speakerName}
  Gender: ${persona.gender}
  Channel type: ${persona.channelType}
  Register tier: ${persona.registerTier} — ${persona.registerDescription}
  Default pronouns to use: ${persona.defaultPronouns.join(", ")}
  Preferred particles: ${persona.preferredParticles.join(", ")}
  Notes: ${persona.notes}

GLOSSARY (keep these exactly in English — do not transliterate, do not translate):
${keepEnglishTerms}

OUTPUT FORMAT: return ONLY valid JSON:
{
  "thai": "...",              // the Thai translation with [P] markers preserved
  "pauseCount": N,             // number of [P] markers in your output
  "estimatedSyllables": N      // your estimate of Thai syllables
}
`.trim();
}
```

**User prompt** — per chunk:

```ts
export function buildTranslationUserPrompt(
  chunk: PreprocessedChunk,
): string {
  const prevBlock = chunk.prevChunkEn
    ? `PREVIOUS CHUNK (context only, do NOT re-translate):\n  EN: ${chunk.prevChunkEn}\n  TH: ${chunk.prevChunkTh ?? "[not translated yet]"}`
    : "PREVIOUS CHUNK: (this is the start of the video)";

  const nextBlock = chunk.nextChunkEn
    ? `UPCOMING CHUNK (context only, do NOT translate this now):\n  EN: ${chunk.nextChunkEn}`
    : "";

  return `
CONTEXT SO FAR:
${chunk.rollingSummary}

${prevBlock}

${nextBlock}

CURRENT CHUNK TO TRANSLATE:
EN: ${chunk.englishTextWithMarkers}

CONSTRAINTS:
- Pause markers in source: ${chunk.pauseCount} (output must contain the same count, in matching positions)
- Target syllables: ${chunk.targetSyllables} (acceptable range: ${chunk.minSyllables}–${chunk.maxSyllables})
- Wall-clock duration: ${chunk.endMs - chunk.startMs}ms

Translate now. Return ONLY the JSON object.
  `.trim();
}
```

### Translator with validation + retry

```ts
// src/translation/translate.ts
export async function translateChunk(
  chunk: PreprocessedChunk,
  persona: PersonaPack,
  glossary: Glossary,
  attempt = 1,
): Promise<string> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    temperature: attempt === 1 ? 0.4 : 0.6, // slightly higher on retry
    messages: [
      { role: "system", content: buildTranslationSystemPrompt(persona, glossary) },
      { role: "user", content: buildTranslationUserPrompt(chunk) },
    ],
  });

  const parsed = JSON.parse(resp.choices[0].message.content!);
  const thai: string = parsed.thai;

  // Validation
  const actualPauses = (thai.match(/\[P\]/g) ?? []).length;
  const actualSyllables = countThaiSyllables(thai);

  const pauseOk = actualPauses === chunk.pauseCount;
  const syllableOk =
    actualSyllables >= chunk.minSyllables &&
    actualSyllables <= chunk.maxSyllables;

  if ((pauseOk && syllableOk) || attempt >= 3) {
    // Strip [P] markers for final output (they were for alignment hints)
    // Keep them if you plan to use for TTS SSML <break> insertion later.
    return thai;
  }

  // Retry with corrective feedback
  console.warn(
    `Chunk ${chunk.chunkIndex} retry ${attempt}: pauses ${actualPauses}/${chunk.pauseCount}, syllables ${actualSyllables} (need ${chunk.minSyllables}-${chunk.maxSyllables})`,
  );
  return translateChunk(chunk, persona, glossary, attempt + 1);
}
```

### Concurrency

Translate chunks in parallel, but bound concurrency to avoid rate limits:

```ts
import pLimit from "p-limit";
const limit = pLimit(5);

const translated = await Promise.all(
  preprocessed.map((chunk, i) =>
    limit(async () => {
      // Fill in prevChunkTh from earlier completions as they finish
      // Simplest: do sequentially to preserve rolling prev context
      return translateChunk(chunk, persona, glossary);
    })
  ),
);
```

**Trade-off:** strict sequential gives you `prevChunkTh` context for every chunk, but is slower. Parallel is faster but loses that context. A middle ground: translate in windows of 3–5 chunks sequentially within a window but windows in parallel. For MVP, go sequential — correctness first.

---

## 9. Stage 5 — Output Formatting

Three output formats, all derived from `TranslatedChunk[]`:

### JSON (primary, for downstream TTS)

```ts
// src/output/writeJson.ts
export function writeJson(path: string, chunks: TranslatedChunk[]) {
  writeFileSync(path, JSON.stringify(chunks, null, 2));
}
```

### Markdown (human-readable review format)

```ts
// src/output/writeMarkdown.ts
export function writeMarkdown(path: string, chunks: TranslatedChunk[]) {
  const lines = [`# Thai Dubbing Transcript\n`];
  for (const c of chunks) {
    lines.push(`## [${msToTimestamp(c.startMs)} → ${msToTimestamp(c.endMs)}]`);
    lines.push(`**EN:** ${c.englishText}`);
    lines.push(`**TH:** ${c.thaiText}`);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"));
}

function msToTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
```

### SRT (subtitle-compatible, ready for video players)

```ts
// src/output/writeSrt.ts
export function writeSrt(path: string, chunks: TranslatedChunk[]) {
  const lines: string[] = [];
  chunks.forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}`);
    lines.push(c.thaiText);
    lines.push("");
  });
  writeFileSync(path, lines.join("\n"));
}
```

---

## 10. CLI Entry Point

```ts
// src/cli.ts
import { ingest } from "./ingestion/youtube.ts";
import { parseVtt } from "./ingestion/vtt.ts";
import { transcribeWithWhisper } from "./transcription/whisper.ts";
import { chunkSegments } from "./preprocessing/chunker.ts";
import { extractPersona } from "./preprocessing/persona.ts";
import { buildGlossary } from "./preprocessing/glossary.ts";
import { preprocessAll } from "./preprocessing/index.ts";
import { translateChunk } from "./translation/translate.ts";
import { writeJson, writeMarkdown, writeSrt } from "./output/index.ts";

const url = process.argv[2];
if (!url) throw new Error("Usage: tsx src/cli.ts <youtube-url>");

// Stage 1
const ingested = await ingest(url);
const outDir = `output/${ingested.videoId}`;

// Stage 2
const transcript = ingested.captionsPath
  ? parseVtt(ingested.captionsPath, ingested.videoId)
  : await transcribeWithWhisper(ingested.audioPath!, ingested.videoId);
writeFileSync(`${outDir}/transcript.en.json`, JSON.stringify(transcript, null, 2));

// Stage 3
const chunks = chunkSegments(transcript.segments);
const persona = await extractPersona(ingested.metadata, chunks);
const glossary = await buildGlossary(chunks, persona.channelType);
const preprocessed = await preprocessAll(chunks, persona, glossary);
writeFileSync(`${outDir}/persona.json`, JSON.stringify(persona, null, 2));
writeFileSync(`${outDir}/glossary.json`, JSON.stringify(glossary, null, 2));
writeFileSync(`${outDir}/preprocessed.json`, JSON.stringify(preprocessed, null, 2));

// Stage 4 (sequential for prev-chunk context)
const translated: TranslatedChunk[] = [];
for (const chunk of preprocessed) {
  if (translated.length > 0) chunk.prevChunkTh = translated.at(-1)!.thaiText;
  const thai = await translateChunk(chunk, persona, glossary);
  translated.push({
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    englishText: chunk.englishText,
    thaiText: thai.replace(/\s*\[P\]\s*/g, " ").trim(), // strip markers from final
  });
}

// Stage 5
writeJson(`${outDir}/transcript.th.json`, translated);
writeMarkdown(`${outDir}/transcript.th.md`, translated);
writeSrt(`${outDir}/transcript.th.srt`, translated);

console.log(`Done. Output in ${outDir}/`);
```

---

## 11. Implementation Order (MVP First)

Build in this order. Each step produces a testable artifact on disk, so you can validate before moving on.

| Step | Build | Test with |
|---|---|---|
| 1 | `ingestion/youtube.ts` | Run against 3 URLs: one with captions, one without, one age-restricted |
| 2 | `ingestion/vtt.ts` + `transcription/whisper.ts` | Transcript JSON is correct for both paths |
| 3 | `preprocessing/chunker.ts` | Use the `sample.json` test from our earlier work — 61/61 chunks matched |
| 4 | `preprocessing/persona.ts` | Inspect generated persona — does it match the actual speaker? |
| 5 | `preprocessing/glossary.ts` | Inspect glossary — are obvious technical terms caught? |
| 6 | **Baseline translation (no preprocessing)** | Single `gpt-4.1-mini` call on full transcript. **Save this — it's your A/B reference.** |
| 7 | Wire up translation with persona + glossary only | Compare to baseline — register/glossary should already improve |
| 8 | Add pause markers | Listen to TTS output — should feel more natural rhythm |
| 9 | Add rolling context + duration budget | Compare full pipeline to baseline |
| 10 | Optimize (parallelism, caching, retry tuning) | — |

---

## 12. How Each Step Beats Vanilla gpt-4.1-mini

This is the A/B test narrative. Build each in isolation; measure each independently.

| Step | What vanilla gpt-4.1-mini does wrong | How preprocessing fixes it |
|---|---|---|
| Chunking | Translates whole transcript at once → loses local context, hits token limits, drifts register mid-video | 5–8s chunks preserve local rhythm; translator focuses on one speech unit |
| Persona pack | Outputs Tier 3 neutral Thai (safe but subtitle-flavored) | Forces tier 2 or 4 — actual YouTube speech register |
| Glossary | Transliterates everything: "อาฟเตอร์เอฟเฟกต์" | Keeps "After Effects" in English where it should be |
| Pause markers | Redistributes pauses arbitrarily → visible mismatch with speaker's mouth | `[P]` count + position preserved → lips match |
| Duration budget | Produces Thai too long for TTS → either gets rushed (unnatural) or overruns the next segment | Target syllable count keeps output fitting naturally |
| Rolling context | Pronouns resolve inconsistently across chunks ("he" sometimes เขา, sometimes หล่อน); topic terms drift | Rolling summary + prev/next chunks keep references stable |

---

## 13. Validation Approach

For each preprocessing step, you need a comparison pair:

```
output/
└── {videoId}/
    ├── transcript.th.baseline.json   # vanilla: one gpt-4.1-mini call, no preprocessing
    ├── transcript.th.chunked.json    # + chunking only
    ├── transcript.th.persona.json    # + chunking + persona
    ├── transcript.th.glossary.json   # + chunking + persona + glossary
    ├── transcript.th.pauses.json     # + pause markers
    ├── transcript.th.context.json    # + rolling context
    └── transcript.th.full.json       # everything
```

**Quantitative checks (fast):**
- `pauseCount` match rate vs. source
- Syllable count within ±15% rate
- Glossary term preservation rate (should be ~100%)
- Register tier consistency (re-run persona extraction *on* the Thai output — does it match intended tier?)

**Qualitative checks (slow but essential):**
- Native Thai speaker rates 10 random chunks per variant on a 1–5 scale for: naturalness, register appropriateness, timing feel. Do this blind (don't tell them which is which).
- TTS each variant with the same Thai TTS voice, A/B to the same speaker.

Budget one afternoon on a 5-minute video with ~40 chunks to get enough signal.

---

## 14. Known Limitations (Honest v1 Tradeoffs)

- **Single-shot per chunk.** No N-best + re-ranking yet. Adding it later roughly triples translation cost but typically adds 10–20% quality on register matches.
- **Rough syllable counter.** The heuristic `countThaiSyllables` is good enough for ±15% validation. For precise timing, integrate a Thai tokenizer later.
- **No speaker diarization.** Multi-speaker videos get one persona pack. For interview-style content you'd want per-speaker personas — add when you have those customers.
- **No viseme awareness.** Mouth-shape matching for close-up talking heads is not implemented. Ship without it; add if/when demanded.
- **No true isochrony enforcement at TTS stage.** The syllable budget is a *prompt hint*, not a hard constraint. The TTS layer still needs SSML rate control or duration prediction to actually land the timing.

---

## 15. Cost Estimate

For a 10-minute YouTube video (~1500 English words):

| Stage | Tokens (approx) | Model | Cost |
|---|---|---|---|
| Whisper transcription | — | whisper-1 | ~$0.06 |
| Persona extraction | 2k in / 0.3k out | gpt-4.1-mini | ~$0.002 |
| Glossary extraction | 3k in / 0.5k out | gpt-4.1-mini | ~$0.003 |
| Rolling summary (×3) | 3k in / 0.5k out total | gpt-4.1-mini | ~$0.003 |
| Translation (×15 chunks) | 30k in / 4k out total | gpt-4.1-mini | ~$0.020 |
| **Total** | | | **~$0.09 per video** |

Cheap enough to run every step on every video in production.

---

## 16. What's Not In Scope For This Plan

- TTS synthesis (separate pipeline)
- Audio mixing / ducking of original
- Lip sync correction (video post-processing)
- Human-in-the-loop review UI
- Episode-to-episode glossary and persona persistence (simple extension: keyed by channelId in a DB)
- Multi-language output (the system prompt changes; the rest stays identical)

---

## Appendix — Raw prompt templates (copy-paste ready)

All prompts are collected in `src/translation/prompts.ts` and interpolated via small template functions. Keep them here in one file so you can diff prompt changes against translation quality easily.

The three you'll actually use:
1. `PERSONA_EXTRACTION_SYSTEM` (Stage 3.2)
2. `GLOSSARY_EXTRACTION_SYSTEM` (Stage 3.3)
3. `buildTranslationSystemPrompt()` + `buildTranslationUserPrompt()` (Stage 4)

All three are defined in full in the sections above.
