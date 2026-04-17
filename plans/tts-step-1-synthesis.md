# Step 1 — TTS Synthesis (Chirp 3 HD Thai)

Synthesize each translated chunk into a WAV file using Google Chirp 3 HD voice `th-TH-Chirp3-HD-Achird`, with optimized pause markup driven by the Whisper word-gap data already collected in the preprocessing stage.

## Scope

**In scope for this step:**

- Convert `transcript.th.json` + `whisper.raw.json` → `output/<videoId>/tts/chunk_NNN.wav`.
- Handle pause markup intelligently (tiered by source gap duration).
- Record cost in the existing usage tracker.
- Concurrency + retry + fallback when markup fails.

**Out of scope (deferred):**

- Duration fitting (atempo / regeneration loop) — Step 2.
- Timeline assembly — Step 3.
- Video muxing — Step 4.
- Video download / ffprobe — these already exist from the previous pipeline (reuse `audio.m4a`/`whisper.raw.json`; video file comes in Step 4).

## Design decisions

### 1. Workspace

TTS code lives in the current repo at `src/tts/`, sharing types, the `output/<videoId>/` folder, and the `src/usage/tracker.ts` cost tracker.

### 2. Pause preservation (requires small upstream change)

**Problem:** `@/Users/mochaccinomm/Desktop/btlw-before-tts/src/cli.ts:79` strips `[P]` markers before writing `transcript.th.json`. The pause-count information that the translator worked hard to preserve is discarded.

**Fix:** in `@/Users/mochaccinomm/Desktop/btlw-before-tts/src/types.ts`, add one field to `TranslatedChunk`:

```ts
thaiTextWithPauses: string; // raw output from translator, retains [P] markers
```

In `cli.ts`, stop stripping — keep both fields (clean one for subtitles, marked one for TTS).

1. Preserve the pause information, maintain the writing of `transcript.th.json` without `[p]` markers.
2. Would be great if we can store the pause information and write it to a separate file or include it in the `transcript.th.json` metadata. Like `thaiText` and `thaiTextWithPauses`.

### 3. Pause tiering — Thai-native refinement (worth the extra compute)

Goal: a dubbed track that breathes like natural Thai, not like a Thai-dressed copy of English rhythm. We combine **two signals** per `[P]`:

- **Signal A — English source gap (ms)**: already computed by `@/Users/mochaccinomm/Desktop/btlw-before-tts/src/preprocessing/pauseMarkers.ts` but discarded. Carry it forward as `pauseGapsMs: number[]`.
- **Signal B — Thai linguistic context around each `[P]`**: particles, clause connectors, topic shifts. An LLM can read this reliably; rules can't.

**Pipeline:**

1. **Data plumbing (cheap):** extend `PauseResult` in `pauseMarkers.ts` to emit `gapsMs: number[]`. Plumb `pauseGapsMs` through `PreprocessedChunk` → `TranslatedChunk`.
2. **Thai-prosody refinement pass (the extra compute):** a dedicated LLM step — `src/tts/pauseRefine.ts` — that takes:
   - the Thai text with `[P]` markers (from translation),
   - the array of source gap durations,
   - a short system prompt about Thai prosody (sentence-final particles ครับ/ค่ะ/นะ/เลย warrant longer pauses; connectors แล้วก็/แต่/หรือ warrant shorter leading pauses; topic shifts merit medium+),

   and returns the same text with each `[P]` replaced by one of `[pause short]`, `[pause]`, `[pause long]`. Count must match input — we validate and fall back to gap-ms tiering on mismatch.

3. **Rule-based fallback / gap-ms heuristic** (used when the LLM pass is disabled, fails, or for VTT path without word gaps):

   | Source gap (ms) | Markup          |
   | --------------- | --------------- |
   | < 500           | `[pause short]` |
   | 500–1000        | `[pause]`       |
   | > 1000          | `[pause long]`  |

**Cost:** the refinement pass uses the same `OPENAI_MODEL` (typically `gpt-4.1-mini`). Batched — one request per ~10 chunks, or one request for the whole video if it fits. Estimated overhead for a 10-minute video (~100 chunks): ~$0.01–0.03. Recorded under step `tts-pause-refine` in the usage tracker.

**Caching:** the refined `thaiTextWithTieredPauses` is persisted to `output/<videoId>/pauses.refined.json`. A rerun that hasn't changed translations reuses it (text + gapsMs hash).

VTT path (no word-level gaps): skip Signal A, rely on the LLM pass alone with an empty `gapsMs`. Still better than flat `[pause]`.

### 4. Audio format

LINEAR16 @ **48kHz mono**. Chirp 3 HD supports 48kHz natively; video audio is 48kHz in ~100% of cases, so later muxing avoids a resample step. Same price. Files ~2× larger than 24kHz but still trivial (~1 MB/min).

### 5. Text preparation — glossary English must sound English

**Directive:** English glossary terms (e.g., `Claude`, `Anthropic`, `React`, `After Effects`, `AI assistant`) must be pronounced in natural English by the TTS, not mangled into Thai phonetics.

**How the translator already helps us:** `@/Users/mochaccinomm/Desktop/btlw-before-tts/src/translation/prompts.ts:21` forces glossary terms to remain in **Latin script** in the Thai output. Verified in current runs — the translator preserves `Claude`, `AI`, `Jordan`, `hallucinations`, etc. as Latin.

**What we do at TTS prep:**

1. **Do NOT use `<sub alias="...">`** — that would force Thai phonetic rendering, which is the opposite of what the user wants.
2. **Keep glossary terms in Latin script, unmodified.** Chirp 3 HD voices are multilingual under the hood; Latin-script runs inside Thai text code-switch to English pronunciation in our internal tests. This is the path that gives _actual English_, not Thai-accented approximation.
3. **Glossary-aware validator before synthesis** — for every glossary entry with `treatment: "keep-english"`, verify the term (or one of its aliases) appears in `thaiTextWithPauses` as Latin script. If we detect that it was inadvertently transliterated into Thai script, log a warning and patch it back to Latin before sending to TTS. This catches translator drift.
4. **Whitespace padding:** ensure a single space on each side of any Latin-script run so Chirp's tokenizer treats it as a distinct foreign-word unit. Runs of Latin-script characters are already space-separated in the translator output — the validator just guarantees it.
5. **Abbreviation handling:** all-caps short terms like `AI`, `UI`, `API` are pronounced letter-by-letter by default by multilingual voices — correct behavior. If a term should be pronounced as a word (e.g., `GIF`), add `"notes": "pronounce as word"` in the glossary and we wrap with `<say-as interpret-as="characters">` only when the note says otherwise. (Optional, not MVP.)
6. **Two input paths (unchanged):**
   - If `[P]` present → use `markup` field with tiered pause tags.
   - If not → use plain `text` field (more stable per Google's docs).

### 6. Concurrency + resilience

- `p-limit(8)` — 8 parallel requests. Chirp 3 HD free tier is 1M chars/month; easily stays under.
- Regional endpoint: `asia-southeast1-texttospeech.googleapis.com` for Bangkok latency.
- **Retry ladder:**
  1. Attempt 1 — markup (if pauses present).
  2. On 400 / "markup" error → retry attempt 2 as plain text (strip `[P]`).
  3. On transient (5xx / network) → exponential backoff, 3 attempts.
- **Idempotent caching:** skip synthesis if `chunk_NNN.wav` already exists AND a sibling `chunk_NNN.meta.json` records matching text + voice + sample rate. This makes reruns and partial-failure recovery cheap.

### 7. Cost tracking

Extend `@/Users/mochaccinomm/Desktop/btlw-before-tts/src/usage/tracker.ts` with a third kind:

```ts
recordTts(step: string, voice: string, characters: number)
```

Chirp 3 HD pricing: **$0.030 per 1,000 characters** (as of writing — add to `src/usage/pricing.ts` under `CHIRP3_HD_PRICE_PER_1K_CHARS`). One entry per successful API call. This keeps the `usage.json` a single source of truth for run cost.

## File layout (new)

```
src/
├── tts/
│   ├── client.ts           # TextToSpeechClient + config constants
│   ├── pauseRefine.ts      # LLM pass: [P] → [pause short|medium|long] using Thai prosody + source gaps
│   ├── glossaryGuard.ts    # Validate/repair Latin-script glossary terms in Thai text
│   ├── textPrep.ts         # Assemble final markup string from refined pauses + validated text
│   ├── synthesize.ts       # Per-chunk: request + write WAV + meta + cache check
│   └── synthesizeAll.ts    # Concurrent driver with retry
└── types.ts                # Add thaiTextWithPauses + pauseGapsMs + thaiTextWithTieredPauses
```

Added outputs per video:

```
output/<videoId>/
├── pauses.refined.json       # cached output of the Thai-prosody pass (chunkIndex → tiered text)
├── tts/
│   ├── chunk_000.wav
│   ├── chunk_000.meta.json   # { text, voice, sampleRate, durationMs, usedMarkup, glossaryPatches }
│   └── …
```

## Upstream edits required (small)

| File                                | Change                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types.ts`                      | Add `thaiTextWithPauses: string`, `pauseGapsMs: number[]`, and `thaiTextWithTieredPauses?: string` to `TranslatedChunk`; add `pauseGapsMs` to `PreprocessedChunk`. |
| `src/preprocessing/pauseMarkers.ts` | Emit `gapsMs: number[]` alongside `count`/`positions`.                                                                                                             |
| `src/preprocessing/index.ts`        | Forward `pauseGapsMs` into each `PreprocessedChunk`.                                                                                                               |
| `src/cli.ts`                        | Stop stripping `[P]`; write both `thaiText` (clean) and `thaiTextWithPauses`. Also plumb `pauseGapsMs`.                                                            |
| `src/usage/pricing.ts`              | Add `CHIRP3_HD_PRICE_PER_1K_CHARS = 0.030`.                                                                                                                        |
| `src/usage/tracker.ts`              | Add `TtsEntry` kind + `recordTts()`; update totals to include `charactersTts`.                                                                                     |

## CLI usage (this step)

A separate entry point so Step 1 can run standalone on an existing translation:

```bash
npx tsx src/cli-tts.ts <videoId>
# reads  output/<videoId>/transcript.th.json
# writes output/<videoId>/tts/chunk_NNN.wav
# updates output/<videoId>/usage.json with TTS costs
```

Later steps will either extend this CLI or call `synthesizeAll` from the main `cli.ts`.

## Dependencies

```bash
npm i @google-cloud/text-to-speech p-limit
```

Auth via ADC: `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS` env var pointing to a service-account JSON.

## Open questions / things I'd like your call on

1. **48kHz vs 24kHz** — I propose 48kHz (rationale above). Object if you'd rather stay at 24kHz.
2. **Pause refinement batching** — batch by ~10 chunks per call (cheap, parallel) vs one call for the whole video (cheapest, fewer round-trips but longer prompt). I lean batched-10.
3. **Refinement model** — reuse `OPENAI_MODEL` from `.env` or hard-pin `gpt-4.1-mini`? I lean reuse, so upgrading the main model also upgrades pause quality.
4. **Glossary guard policy on violation** — (a) log-and-patch back to Latin, (b) log-only, (c) refuse to synthesize and fail loudly. I lean (a) for resilience; (c) is safer for audits.
5. **Standalone `cli-tts.ts` vs extending `cli.ts`** — a separate script lets you re-run TTS on an existing translation without re-translating. Can merge later.
6. **Regen on translation rerun** — should `thaiTextWithPauses` invalidate the TTS cache automatically? (Yes: the meta.json text check catches this.)

## Verification

- Run on the existing `output/005JLRt3gXI/` (Anthropic Jordan video — has glossary terms like `Claude`, `Anthropic`, `hallucinations`, `Jordan`).
- **Glossary ear-test:** confirm `Claude` and `Anthropic` are pronounced in English, not as Thai phonetic approximations.
- **Pause ear-test:** compare refined vs flat-`[pause]` output on 2–3 chunks that have sentence-final particles and connectors — refined should feel more native.
- Confirm `pauses.refined.json` is written and reused on second run (zero LLM calls on rerun, tracker shows $0.00 for `tts-pause-refine`).
- Confirm cache-hit on TTS: second run produces zero TTS API calls; tracker shows $0.00 for TTS step.
- Confirm fallback: corrupt a markup chunk and see it retry as plain text.
- Confirm glossary guard: feed a chunk where `Claude` was mis-transliterated to `เคลาด์` and see the guard patch it back + log warning.
