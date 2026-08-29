import AsyncStorage from "@react-native-async-storage/async-storage";

import { voiceHttpBaseUrl } from "./voiceTransport";

export type VoiceMode = "off" | "tap" | "auto";

export type TranscriptionProgress = {
  progress: number;
  etaSeconds: number | null;
  elapsedSeconds: number | null;
  audioDurationSeconds: number | null;
  estimated: boolean;
};

const MODE_KEY = "milo.voice.mode.v1";
export const WHISPER_MODEL = "Systran/faster-whisper-medium.en";
export const KOKORO_VOICE = "bm_george";
export const KOKORO_PLAYBACK_RATE = 1.1;


/**
 * Reduce assistant markdown to text that is actually useful to hear aloud.
 * A turn containing only code, images, embeds, or bare URLs should not produce
 * a voice-reply card at all.
 */
export function prepareSpeechText(markdown: string): string {
  return markdown
    // Code is visual reference material, not prose. Strip fenced blocks first
    // so their backticks cannot be mistaken for inline code below.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    // Images should not create a voice card by themselves. Ordinary links keep
    // their human-readable label but discard the URL.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // HTML-ish embeds/tags and standalone URLs are non-speakable chrome.
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    // Remove common Markdown structure while preserving the words.
    .replace(/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/gm, " ")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getVoiceMode(): Promise<VoiceMode> {
  const saved = await AsyncStorage.getItem(MODE_KEY);
  return saved === "tap" || saved === "auto" || saved === "off" ? saved : "tap";
}

export async function setVoiceMode(mode: VoiceMode): Promise<void> {
  await AsyncStorage.setItem(MODE_KEY, mode);
}

export function nextVoiceMode(mode: VoiceMode): VoiceMode {
  if (mode === "off") return "tap";
  if (mode === "tap") return "auto";
  return "off";
}

export function voiceModeLabel(mode: VoiceMode): string {
  if (mode === "off") return "Off";
  if (mode === "tap") return "Tap";
  return "Auto";
}

async function transcriptionText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Voice transcription failed (${response.status})`);
  const payload = (await response.json()) as { text?: string } | string;
  const text = typeof payload === "string" ? payload : payload.text;
  if (!text?.trim()) throw new Error("Whisper returned an empty transcription.");
  return text.trim();
}

export async function transcribeVoice(
  uri: string,
  token: string,
  serverUrl: string,
  options?: { durationSeconds?: number; onProgress?: (progress: TranscriptionProgress) => void },
): Promise<string> {
  const voiceBaseUrl = voiceHttpBaseUrl(serverUrl);
  const body = new FormData();
  body.append("model", WHISPER_MODEL);
  body.append("file", { uri, name: "milo-voice.m4a", type: "audio/mp4" } as never);
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options?.durationSeconds && options.durationSeconds > 0
      ? { "X-Audio-Duration-Seconds": String(options.durationSeconds) }
      : {}),
  };
  const response = await fetch(`${voiceBaseUrl}/voice/transcribe`, {
    method: "POST",
    headers,
    body,
  });

  // Newer gateways acknowledge the upload immediately and transcribe in a
  // background job. This avoids holding a Cloudflare HTTP request open for the
  // entire Whisper run on long voice messages. Older gateways still work too.
  if (response.status !== 202) return transcriptionText(response);
  const accepted = (await response.json()) as {
    job_id?: string;
    progress?: number;
    eta_seconds?: number;
    audio_duration_seconds?: number | null;
    estimate?: boolean;
  };
  if (!accepted.job_id) throw new Error("Voice transcription job was not created.");
  options?.onProgress?.({
    progress: accepted.progress ?? 0,
    etaSeconds: accepted.eta_seconds ?? null,
    elapsedSeconds: 0,
    audioDurationSeconds: accepted.audio_duration_seconds ?? options?.durationSeconds ?? null,
    estimated: accepted.estimate ?? true,
  });

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const poll = await fetch(`${voiceBaseUrl}/voice/transcribe/${encodeURIComponent(accepted.job_id)}`, { headers });
    if (poll.status === 202) {
      const status = (await poll.json()) as {
        progress?: number;
        eta_seconds?: number;
        elapsed_seconds?: number;
        audio_duration_seconds?: number | null;
        estimate?: boolean;
      };
      options?.onProgress?.({
        progress: status.progress ?? 0,
        etaSeconds: status.eta_seconds ?? null,
        elapsedSeconds: status.elapsed_seconds ?? null,
        audioDurationSeconds: status.audio_duration_seconds ?? options?.durationSeconds ?? null,
        estimated: status.estimate ?? true,
      });
      continue;
    }
    const text = await transcriptionText(poll);
    options?.onProgress?.({
      progress: 1,
      etaSeconds: 0,
      elapsedSeconds: null,
      audioDurationSeconds: options?.durationSeconds ?? null,
      estimated: false,
    });
    // Give the completed 100% state one visible frame before the composer
    // replaces the progress panel with the transcript.
    await new Promise((resolve) => setTimeout(resolve, 180));
    return text;
  }
  throw new Error("Voice transcription timed out after 15 minutes.");
}

export function speechSource(text: string, token: string, serverUrl: string) {
  const voiceBaseUrl = voiceHttpBaseUrl(serverUrl);
  const clipped = text.slice(0, 12000);
  const query = new URLSearchParams({ text: clipped, voice: KOKORO_VOICE });
  return {
    uri: `${voiceBaseUrl}/voice/speech?${query.toString()}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}
