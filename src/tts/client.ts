import { TextToSpeechClient } from "@google-cloud/text-to-speech";

// Bangkok-local endpoint for lowest latency. Falls back to global automatically
// if the regional endpoint is unreachable from your network.
export const ttsClient = new TextToSpeechClient({
  apiEndpoint: "asia-southeast1-texttospeech.googleapis.com",
});

export const VOICE_NAME = "th-TH-Chirp3-HD-Achird";
export const LANGUAGE_CODE = "th-TH";

// 48kHz LINEAR16 mono — matches typical video audio, avoids downstream resampling.
export const SAMPLE_RATE_HZ = 48_000;
export const AUDIO_ENCODING = "LINEAR16" as const;
