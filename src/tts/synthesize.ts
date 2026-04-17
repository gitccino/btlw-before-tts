import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ttsClient,
  VOICE_NAME,
  LANGUAGE_CODE,
  SAMPLE_RATE_HZ,
  AUDIO_ENCODING,
} from "./client.js";
import { recordTts } from "../usage/tracker.js";
import type { TtsInput } from "./textPrep.js";

export interface SynthesizeResult {
  wavPath: string;
  metaPath: string;
  characters: number;
  usedMarkup: boolean;
  cached: boolean;
  glossaryPatches: TtsInput["glossaryPatches"];
}

interface MetaFile {
  chunkIndex: number;
  voice: string;
  sampleRateHz: number;
  encoding: string;
  field: "text" | "markup";
  content: string;
  contentHash: string;
  characters: number;
  glossaryPatches: TtsInput["glossaryPatches"];
  guardWarnings: string[];
  generatedAt: string;
}

export async function synthesizeChunk(
  chunkIndex: number,
  input: TtsInput,
  outDir: string,
): Promise<SynthesizeResult> {
  const wavPath = resolve(outDir, "tts", `chunk_${pad(chunkIndex)}.wav`);
  const metaPath = resolve(outDir, "tts", `chunk_${pad(chunkIndex)}.meta.json`);
  const contentHash = djb2(
    JSON.stringify({
      field: input.field,
      content: input.content,
      voice: VOICE_NAME,
      sampleRateHz: SAMPLE_RATE_HZ,
    }),
  );

  // Cache hit — unchanged input, unchanged voice/format
  if (existsSync(wavPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as MetaFile;
      if (meta.contentHash === contentHash) {
        return {
          wavPath,
          metaPath,
          characters: meta.characters,
          usedMarkup: meta.field === "markup",
          cached: true,
          glossaryPatches: meta.glossaryPatches,
        };
      }
    } catch {
      // fall through to re-synthesize
    }
  }

  mkdirSync(dirname(wavPath), { recursive: true });

  const request = buildRequest(input);
  const [response] = await ttsClient.synthesizeSpeech(request);
  const audio = response.audioContent;
  if (!audio) throw new Error(`Empty TTS response for chunk ${chunkIndex}`);

  writeFileSync(wavPath, Buffer.from(audio as Uint8Array));
  recordTts("tts", VOICE_NAME, input.characters);

  const meta: MetaFile = {
    chunkIndex,
    voice: VOICE_NAME,
    sampleRateHz: SAMPLE_RATE_HZ,
    encoding: AUDIO_ENCODING,
    field: input.field,
    content: input.content,
    contentHash,
    characters: input.characters,
    glossaryPatches: input.glossaryPatches,
    guardWarnings: input.guardWarnings,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  return {
    wavPath,
    metaPath,
    characters: input.characters,
    usedMarkup: input.field === "markup",
    cached: false,
    glossaryPatches: input.glossaryPatches,
  };
}

// Build the Chirp 3 HD request. Note: "markup" and "text" are mutually exclusive
// input fields — we pick one based on whether pause tags are present.
function buildRequest(input: TtsInput) {
  const inputField =
    input.field === "markup"
      ? { markup: input.content }
      : { text: input.content };

  return {
    voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
    audioConfig: {
      audioEncoding: AUDIO_ENCODING,
      sampleRateHertz: SAMPLE_RATE_HZ,
    },
    input: inputField,
  };
}

export function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function djb2(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
