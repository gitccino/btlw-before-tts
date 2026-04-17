import OpenAI from "openai";
import "dotenv/config";
import type { Chunk } from "../types.js";
import { recordChat } from "../usage/tracker.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Returns a map of chunkIndex → rollingSummary to attach before translation.
// Summary regenerates every summaryEveryN chunks to stay current without
// paying for a summarization call on every single chunk.
export async function buildRollingContext(
  chunks: Chunk[],
  summaryEveryN = 5,
): Promise<Map<number, string>> {
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
  const text = chunksSoFar.map((c) => c.englishText).join(" ");
  const resp = await openai.chat.completions.create({
    model: openaiModel,
    temperature: 0.2,
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content:
          "Summarize what has been covered in this YouTube video so far in 2-3 sentences. Focus on topic, who/what is involved, and tone. This summary will help a translator maintain context.",
      },
      { role: "user", content: text },
    ],
  });
  recordChat("context-summary", openaiModel, resp.usage);
  return resp.choices[0].message.content!.trim();
}
