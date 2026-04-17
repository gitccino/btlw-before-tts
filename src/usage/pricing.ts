// OpenAI pricing — USD per 1M tokens.
// Sources: https://openai.com/api/pricing/ (verify occasionally; these change).

export interface ModelPrice {
  input: number; // $ / 1M input tokens
  cachedInput: number; // $ / 1M cached input tokens
  output: number; // $ / 1M output tokens
}

export const PRICING: Record<string, ModelPrice> = {
  // GPT-4.1 family
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },

  // GPT-4o family
  "gpt-4o": { input: 5, cachedInput: 0, output: 15 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },

  // GPT-5 family
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },

  // Reasoning models
  o3: { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "o3-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
  "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 },
};

export const WHISPER_PRICE_PER_MINUTE = 0.006;

// Google Chirp 3 HD — $0.030 per 1,000 characters (verify occasionally).
// https://cloud.google.com/text-to-speech/pricing
export const CHIRP3_HD_PRICE_PER_1K_CHARS = 0.03;

const FALLBACK_MODEL = "gpt-4.1-mini";
const warnedModels = new Set<string>();

export function getPrice(model: string): ModelPrice {
  const exact = PRICING[model];
  if (exact) return exact;

  // Try stripping date suffixes like "-2024-08-06"
  const stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const matched = PRICING[stripped];
  if (matched) return matched;

  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(
      `[usage] unknown model "${model}", falling back to ${FALLBACK_MODEL} pricing for cost estimates`,
    );
  }
  return PRICING[FALLBACK_MODEL];
}

export function costForChat(
  model: string,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): number {
  const p = getPrice(model);
  const uncachedPrompt = Math.max(0, promptTokens - cachedTokens);
  return (
    (uncachedPrompt * p.input +
      cachedTokens * p.cachedInput +
      completionTokens * p.output) /
    1_000_000
  );
}

export function costForAudio(minutes: number): number {
  return minutes * WHISPER_PRICE_PER_MINUTE;
}

export function costForTts(characters: number): number {
  return (characters / 1000) * CHIRP3_HD_PRICE_PER_1K_CHARS;
}
