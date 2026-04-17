import { writeFileSync } from "node:fs";
import { costForChat, costForAudio } from "./pricing.js";

export interface ChatEntry {
  step: string;
  model: string;
  kind: "chat";
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface AudioEntry {
  step: string;
  model: string;
  kind: "audio";
  minutes: number;
  costUsd: number;
  timestamp: string;
}

export type UsageEntry = ChatEntry | AudioEntry;

export interface StepTotal {
  calls: number;
  costUsd: number;
}

export interface UsageTotals {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  audioMinutes: number;
  costUsd: number;
  byStep: Record<string, StepTotal>;
  byModel: Record<string, StepTotal>;
}

// Minimal shape of OpenAI completion usage (avoids tight SDK coupling).
export interface ChatUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const entries: UsageEntry[] = [];

export function recordChat(
  step: string,
  model: string,
  usage: ChatUsageLike | undefined | null,
): void {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const costUsd = costForChat(
    model,
    promptTokens,
    cachedTokens,
    completionTokens,
  );
  entries.push({
    step,
    model,
    kind: "chat",
    promptTokens,
    cachedTokens,
    completionTokens,
    costUsd,
    timestamp: new Date().toISOString(),
  });
}

export function recordAudio(
  step: string,
  model: string,
  minutes: number,
): void {
  const costUsd = costForAudio(minutes);
  entries.push({
    step,
    model,
    kind: "audio",
    minutes,
    costUsd,
    timestamp: new Date().toISOString(),
  });
}

export function getEntries(): UsageEntry[] {
  return entries.slice();
}

export function getTotals(): UsageTotals {
  const totals: UsageTotals = {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    audioMinutes: 0,
    costUsd: 0,
    byStep: {},
    byModel: {},
  };

  for (const e of entries) {
    totals.costUsd += e.costUsd;

    if (e.kind === "chat") {
      totals.promptTokens += e.promptTokens;
      totals.cachedTokens += e.cachedTokens;
      totals.completionTokens += e.completionTokens;
    } else {
      totals.audioMinutes += e.minutes;
    }

    const step = (totals.byStep[e.step] ??= { calls: 0, costUsd: 0 });
    step.calls += 1;
    step.costUsd += e.costUsd;

    const model = (totals.byModel[e.model] ??= { calls: 0, costUsd: 0 });
    model.calls += 1;
    model.costUsd += e.costUsd;
  }

  return totals;
}

export function writeTo(path: string, defaultModel?: string): void {
  const payload = {
    model: defaultModel,
    generatedAt: new Date().toISOString(),
    totals: getTotals(),
    entries: getEntries(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

export function reset(): void {
  entries.length = 0;
}
