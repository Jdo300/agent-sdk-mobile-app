import AsyncStorage from "@react-native-async-storage/async-storage";

import { voiceHttpBaseUrl } from "./voiceTransport";

export type VoiceMode = "off" | "tap" | "auto";

export type TranscriptionProgress = {
  phase: "preparing" | "uploading" | "transcribing" | "finishing";
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

export type AcceptedTranscriptionJob = {
  job_id?: string;
  progress?: number;
  eta_seconds?: number;
  audio_duration_seconds?: number | null;
  estimate?: boolean;
};

class VoiceUploadRetryableError extends Error {}

const VOICE_UPLOAD_STALL_MS = 12_000;
const VOICE_UPLOAD_MAX_ATTEMPTS = 3;

function uploadVoice(
  url: string,
  headers: Record<string, string>,
  body: FormData,
  audioDurationSeconds: number | null,
  attempt: number,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    let settled = false;
    let lastLoaded = 0;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const clearStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const failRetryable = (message: string) => {
      if (settled) return;
      settled = true;
      clearStallTimer();
      try { xhr.abort(); } catch {}
      console.info("[bloop-voice] upload retryable failure", { attempt, loaded: lastLoaded, message });
      reject(new VoiceUploadRetryableError(message));
    };
    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        failRetryable("Voice upload stalled.");
      }, VOICE_UPLOAD_STALL_MS);
    };

    xhr.open("POST", url);
    // This is the outer safety net. The progress watchdog below is intentionally
    // much shorter so a half-alive iOS radio/socket retries without user action.
    xhr.timeout = 120_000;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (settled) return;
      const now = Date.now();
      if (event.loaded > lastLoaded) {
        lastLoaded = event.loaded;
        armStallTimer();
      }
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const total = event.lengthComputable && event.total > 0 ? event.total : 0;
      const fraction = total > 0 ? Math.max(0, Math.min(0.99, event.loaded / total)) : 0;
      const bytesPerSecond = elapsed > 0.15 ? event.loaded / elapsed : 0;
      const eta = total > event.loaded && bytesPerSecond > 0 ? (total - event.loaded) / bytesPerSecond : null;
      onProgress?.({
        phase: "uploading",
        progress: fraction,
        etaSeconds: eta,
        elapsedSeconds: elapsed,
        audioDurationSeconds,
        estimated: true,
      });
    };
    xhr.onerror = () => failRetryable("Voice upload failed.");
    xhr.ontimeout = () => failRetryable("Voice upload timed out.");
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearStallTimer();
      console.info("[bloop-voice] upload completed", { attempt, status: xhr.status, loaded: lastLoaded });
      resolve({ status: xhr.status, text: xhr.responseText ?? "" });
    };
    // Cover the specific failure where RN creates the XHR but emits no initial
    // upload progress at all. Any real byte movement rearms this timer.
    armStallTimer();
    console.info("[bloop-voice] upload started", { attempt });
    xhr.send(body);
  });
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
  const makeBody = () => {
    const body = new FormData();
    body.append("model", WHISPER_MODEL);
    // Speaches can stream completed Whisper segments over SSE. The voice gateway
    // consumes those milestones server-side for real progress/ETA updates while
    // preserving Bloop's simple asynchronous job API.
    body.append("stream", "true");
    body.append("file", { uri, name: "milo-voice.m4a", type: "audio/mp4" } as never);
    return body;
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options?.durationSeconds && options.durationSeconds > 0
      ? { "X-Audio-Duration-Seconds": String(options.durationSeconds) }
      : {}),
  };
  const audioDurationSeconds = options?.durationSeconds && options.durationSeconds > 0 ? options.durationSeconds : null;
  options?.onProgress?.({
    phase: "uploading",
    progress: 0,
    etaSeconds: null,
    elapsedSeconds: 0,
    audioDurationSeconds,
    estimated: true,
  });
  let upload: { status: number; text: string } | null = null;
  for (let attempt = 1; attempt <= VOICE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      upload = await uploadVoice(
        `${voiceBaseUrl}/voice/transcribe`,
        headers,
        makeBody(),
        audioDurationSeconds,
        attempt,
        options?.onProgress,
      );
      break;
    } catch (error) {
      if (!(error instanceof VoiceUploadRetryableError) || attempt >= VOICE_UPLOAD_MAX_ATTEMPTS) throw error;
      console.info("[bloop-voice] retrying upload", { attempt, nextAttempt: attempt + 1 });
      options?.onProgress?.({
        phase: "uploading",
        progress: 0,
        etaSeconds: null,
        elapsedSeconds: 0,
        audioDurationSeconds,
        estimated: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  if (!upload) throw new Error("Voice upload failed.");

  // Newer gateways acknowledge the upload immediately and transcribe in a
  // background job. This avoids holding a Cloudflare HTTP request open for the
  // entire Whisper run on long voice messages. Older gateways still work too.
  if (upload.status !== 202) {
    if (upload.status < 200 || upload.status >= 300) throw new Error(`Voice transcription failed (${upload.status})`);
    const payload = JSON.parse(upload.text) as { text?: string } | string;
    const text = typeof payload === "string" ? payload : payload.text;
    if (!text?.trim()) throw new Error("Whisper returned an empty transcription.");
    return text.trim();
  }
  const accepted = JSON.parse(upload.text) as AcceptedTranscriptionJob;
  return pollAcceptedTranscription(accepted, token, serverUrl, options);
}

export async function pollAcceptedTranscription(
  accepted: AcceptedTranscriptionJob,
  token: string,
  serverUrl: string,
  options?: { durationSeconds?: number; onProgress?: (progress: TranscriptionProgress) => void },
): Promise<string> {
  const voiceBaseUrl = voiceHttpBaseUrl(serverUrl);
  const headers = { Authorization: `Bearer ${token}` };
  if (!accepted.job_id) throw new Error("Voice transcription job was not created.");
  let progressAnchor: TranscriptionProgress = {
    phase: "transcribing",
    progress: accepted.progress ?? 0,
    etaSeconds: accepted.eta_seconds ?? null,
    elapsedSeconds: 0,
    audioDurationSeconds: accepted.audio_duration_seconds ?? options?.durationSeconds ?? null,
    estimated: accepted.estimate ?? true,
  };
  let progressAnchorAt = Date.now();
  options?.onProgress?.(progressAnchor);

  // Server polling stays deliberately modest, but the UI should feel live.
  // Between authoritative estimates, advance the same elapsed/ETA model locally
  // at 10 Hz. Each server poll re-anchors this interpolation so it cannot drift.
  const progressTicker = options?.onProgress
    ? setInterval(() => {
        if (!progressAnchor.estimated || progressAnchor.progress >= 0.95) return;
        const sinceAnchor = Math.max(0, (Date.now() - progressAnchorAt) / 1000);
        const anchorElapsed = progressAnchor.elapsedSeconds ?? 0;
        const anchorEta = progressAnchor.etaSeconds;
        if (anchorEta === null || anchorEta <= 0) return;
        const estimatedTotal = Math.max(0.1, anchorElapsed + anchorEta);
        const elapsed = anchorElapsed + sinceAnchor;
        options.onProgress?.({
          ...progressAnchor,
          phase: "transcribing",
          progress: Math.min(0.95, Math.max(progressAnchor.progress, (elapsed / estimatedTotal) * 0.95)),
          etaSeconds: Math.max(0, estimatedTotal - elapsed),
          elapsedSeconds: elapsed,
        });
      }, 100)
    : null;

  const deadline = Date.now() + 15 * 60 * 1000;
  try {
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
      progressAnchor = {
        phase: "transcribing",
        progress: status.progress ?? 0,
        etaSeconds: status.eta_seconds ?? null,
        elapsedSeconds: status.elapsed_seconds ?? null,
        audioDurationSeconds: status.audio_duration_seconds ?? options?.durationSeconds ?? null,
        estimated: status.estimate ?? true,
      };
      progressAnchorAt = Date.now();
      options?.onProgress?.(progressAnchor);
      continue;
    }
    const text = await transcriptionText(poll);
    options?.onProgress?.({
      phase: "finishing",
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
  } finally {
    if (progressTicker) clearInterval(progressTicker);
  }
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
