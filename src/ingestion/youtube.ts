import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
  captionsPath: string | null; // null if none or auto-only
  audioPath: string | null;    // set if we had to fall back to Whisper
  videoPath: string | null;    // set only if downloadVideo: true
}

export interface IngestOptions {
  downloadVideo?: boolean; // default false — video file not needed for dubbing pipeline
}

export async function ingest(
  url: string,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const info = await fetchInfoJson(url);
  const videoId = info.id as string;
  const outDir = join("output", videoId);
  mkdirSync(outDir, { recursive: true });

  // Only manual subtitles qualify — auto_captions is treated as no captions
  const hasManualEn =
    info.subtitles != null &&
    typeof info.subtitles === "object" &&
    "en" in info.subtitles;

  const captionsPath = hasManualEn
    ? await downloadCaptions(url, videoId, outDir)
    : null;
  const audioPath =
    captionsPath === null ? await downloadAudio(url, videoId, outDir) : null;
  const videoPath = options.downloadVideo
    ? await downloadVideo(url, videoId, outDir)
    : null;

  return {
    videoId,
    metadata: extractMetadata(info),
    captionsPath,
    audioPath,
    videoPath,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function fetchInfoJson(url: string): Promise<Record<string, unknown>> {
  const tmpTemplate = join("output", "%(id)s", "%(id)s");
  mkdirSync("output", { recursive: true });

  try {
    await execFileP("yt-dlp", [
      "--skip-download",
      "--write-info-json",
      "-o",
      tmpTemplate,
      url,
    ]);
  } catch (err: unknown) {
    throwYtDlpError(err);
  }

  // yt-dlp writes to output/<id>/<id>.info.json but we don't know the id yet.
  // Re-run with --print id to get it cleanly.
  const { stdout } = await execFileP("yt-dlp", ["--print", "id", url]).catch(
    (err: unknown) => {
      throwYtDlpError(err);
      return { stdout: "" };
    }
  );
  const videoId = stdout.trim();
  const infoPath = join("output", videoId, `${videoId}.info.json`);
  const raw = readFileSync(infoPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function downloadCaptions(
  url: string,
  videoId: string,
  outDir: string
): Promise<string> {
  const template = join(outDir, videoId);
  try {
    await execFileP("yt-dlp", [
      "--skip-download",
      "--write-sub",
      "--sub-lang",
      "en",
      "--sub-format",
      "vtt",
      "-o",
      template,
      url,
    ]);
  } catch (err: unknown) {
    throwYtDlpError(err);
  }
  return join(outDir, `${videoId}.en.vtt`);
}

async function downloadAudio(
  url: string,
  _videoId: string,
  outDir: string
): Promise<string> {
  const template = join(outDir, "audio.%(ext)s");
  try {
    await execFileP("yt-dlp", [
      "-x",
      "--audio-format",
      "m4a",
      "-o",
      template,
      url,
    ]);
  } catch (err: unknown) {
    throwYtDlpError(err);
  }
  return join(outDir, "audio.m4a");
}

async function downloadVideo(
  url: string,
  videoId: string,
  outDir: string
): Promise<string> {
  const template = join(outDir, "video.%(ext)s");
  try {
    await execFileP("yt-dlp", [
      "-f",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      template,
      url,
    ]);
  } catch (err: unknown) {
    throwYtDlpError(err);
  }
  return join(outDir, `${videoId}.mp4`);
}

function extractMetadata(info: Record<string, unknown>) {
  return {
    title: String(info.title ?? ""),
    description: String(info.description ?? ""),
    channel: String(info.channel ?? info.uploader ?? ""),
    durationSec: Number(info.duration ?? 0),
    uploadDate: String(info.upload_date ?? ""),
  };
}

function throwYtDlpError(err: unknown): never {
  if (
    err &&
    typeof err === "object" &&
    "stderr" in err &&
    typeof (err as { stderr: unknown }).stderr === "string"
  ) {
    const stderr = (err as { stderr: string }).stderr;
    if (stderr.includes("Sign in") || stderr.includes("age-restricted")) {
      throw new Error(`Age-restricted or login-required: ${stderr.trim()}`);
    }
    if (stderr.includes("not available") || stderr.includes("geo")) {
      throw new Error(`Geo-blocked or unavailable: ${stderr.trim()}`);
    }
    throw new Error(`yt-dlp failed: ${stderr.trim()}`);
  }
  throw err;
}
