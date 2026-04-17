# Next Implementation Plan — Preprocessing Fixes v2

Based on analysis of `transcript-mc8000-mg1500_th.json` and `transcript-mc12000-mg1500_th.json`.

**Root cause summary:** three fixes were planned in v1 but never implemented. Everything else is a downstream symptom of these three gaps.

---

## Fix 1 — Particle allowlist (30 min, prompt only)

**Problem:** uniform ค่ะ on every chunk. Model produces นะ (too casual) and จ่ะ (archaic) on other runs.

**Change:** replace "preferred particles" section in `buildTranslationSystemPrompt()` with a hard allowlist + ban list.

```
SENTENCE-FINAL PARTICLES — HARD ALLOWLIST:
Use ONLY these. Nothing outside this list is permitted.

  Allowed:
    ค่ะ      — neutral polite statement
    นะคะ     — warm, explanatory
    เลยค่ะ   — emphasis or conclusion
    ด้วยค่ะ  — additive ("as well")
    (none)   — factual or mid-flow statements

  BANNED — never use:
    นะ       (too casual without ค่ะ)
    จ่ะ      (archaic, unnatural)
    คะ       (clipped, sounds abrupt)
    เลย      (too casual without ค่ะ)
    ครับ     (wrong gender)

DISTRIBUTION TARGET per 10 sentences:
  ค่ะ:           3–4 times
  นะคะ:          2–3 times
  เลยค่ะ/ด้วยค่ะ: 1–2 times
  (none):        2–3 times
```

**Validate (free, no TTS):** re-translate and run this check:

```bash
python3 -c "
import json
chunks = json.load(open('output/{id}/transcript.th.json'))
banned = ['นะ ', 'จ่ะ', 'คะ\n', 'เลย\n']
for i, c in enumerate(chunks):
    for b in banned:
        if c['thaiText'].endswith(b.strip()):
            print(f'chunk {i}: banned particle found — {b.strip()}')
endings = [c['thaiText'].rstrip()[-6:] for c in chunks]
print('Endings:', endings)
"
```

---

## Fix 2 — Completeness validator + retry (1 hr, code + prompt)

**Problem:** chunks end mid-sentence. Two confirmed patterns:

- `...ความร่วมมือที่` — GivingTuesday dropped
- `...ระบบนิเวศ ไม่ใช่แค่` — "a product" dropped

**Cause of `ไม่ใช่แค่` specifically:** forward context (next chunk starting with "นั่น...") misleads the model into thinking the sentence continues there. Add an explicit guard in the prompt:

```
COMPLETENESS RULES:
1. Every chunk must end as a grammatically complete thought.
2. "ไม่ใช่แค่ X" constructions: ALWAYS include X.
   "...ระบบนิเวศ ไม่ใช่แค่" = WRONG (missing the noun)
   "...ระบบนิเวศ ไม่ใช่แค่ผลิตภัณฑ์" = CORRECT
3. The next chunk's content is NOT a continuation of this chunk.
   This chunk must be self-contained.
4. Never drop proper nouns (names, org names, product names)
   to save syllables. They are mandatory.
```

**Code change** in `src/translation/translate.ts`:

```typescript
const INCOMPLETE_ENDINGS = [
  "แค่",
  "ที่",
  "และ",
  "หรือ",
  "เป็น",
  "ของ",
  "ใน",
  "สำหรับ",
  "โดย",
];

function looksIncomplete(thai: string): boolean {
  const t = thai.trim();
  return INCOMPLETE_ENDINGS.some((e) => t.endsWith(e));
}

// In translateChunk(), after parsing the response:
if (looksIncomplete(thai) && attempt < 3) {
  return translateChunk(
    chunk,
    persona,
    glossary,
    attempt + 1,
    `INCOMPLETE: your translation ends with "${thai.trim().slice(-8)}".` +
      ` Complete the sentence. Previous attempt: "${thai}"`,
  );
}
```

---

## Fix 3 — Syllable budget enforcement + retry (1 hr, code + prompt)

**Problem:** 9/10 chunks in mc8000 are over budget. Ratios range from 1.10× to 2.62×. Budget constraint in the prompt is being ignored entirely. No retry loop exists.

**Prompt change** — strengthen the constraint language:

```
SYLLABLE BUDGET — HARD LIMIT:
Duration: {duration_ms}ms → target: {target} syllables → MAX: {max} syllables.

This is a HARD CAP, not a suggestion. If you exceed {max} syllables,
your response will be rejected and you will be asked to retry.

If the full meaning cannot fit:
  1. Rephrase using shorter Thai equivalents first.
  2. Then drop secondary modifiers (adverbs, adjectives).
  3. NEVER drop: proper nouns, main verbs, main objects.
  4. A shorter complete translation beats a longer truncated one.
```

**Code change** — add budget validation to the retry loop:

```typescript
export async function translateChunk(
  chunk: PreprocessedChunk,
  persona: PersonaPack,
  glossary: Glossary,
  attempt = 1,
  feedback?: string,
): Promise<string> {
  const resp = await openai.chat.completions.create({
    /* ... */
  });
  const thai = JSON.parse(resp.choices[0].message.content!).thai;

  const syllables = countThaiSyllables(thai);
  const incomplete = looksIncomplete(thai);
  const overBudget = syllables > chunk.maxSyllables;

  if ((overBudget || incomplete) && attempt < 3) {
    const reasons: string[] = [];
    if (overBudget)
      reasons.push(`${syllables} syllables, max is ${chunk.maxSyllables}`);
    if (incomplete)
      reasons.push(`ends with "${thai.trim().slice(-8)}" (incomplete)`);

    return translateChunk(
      chunk,
      persona,
      glossary,
      attempt + 1,
      `REJECTED (${reasons.join("; ")}).\nPrevious: "${thai}"\nFix both issues.`,
    );
  }

  return thai;
}
```

---

## Default chunk size: stay on mc8000

Both mc8000 and mc12000 have the same truncation problems. mc12000's wider window doesn't fix the root cause — it just incidentally gave GivingTuesday more room on one chunk.

`maxChunkDurationMs: 8000` is correct for dubbing because it gives the TTS fitting stage granular, manageable clips. Keep it.

---

## Implementation order

All three fixes are independent. Apply in this sequence to isolate each effect:

```
1. Apply Fix 1 (prompt only) → re-translate → check particle distribution
2. Apply Fix 2 (prompt + code) → re-translate → check no incomplete endings
3. Apply Fix 3 (prompt + code) → re-translate → check syllable ratios
4. Re-synthesize only after all three pass JSON validation
```

Do not re-synthesize until the JSON passes. Each TTS call costs money and the JSON check is free.

---

## Success criteria

| Metric                         | Current    | Target |
| ------------------------------ | ---------- | ------ |
| Chunks with incomplete endings | 2/10       | 0/10   |
| Chunks over syllable budget    | 9/10       | ≤ 2/10 |
| TTS regeneration rate          | 50%        | < 20%  |
| Chunks ending only in ค่ะ      | 8/10       | ≤ 4/10 |
| Banned particles (นะ, จ่ะ)     | occasional | 0      |
