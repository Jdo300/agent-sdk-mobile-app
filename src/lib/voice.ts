import AsyncStorage from "@react-native-async-storage/async-storage";

export type VoiceMode = "off" | "tap" | "auto";

const MODE_KEY = "milo.voice.mode.v1";
export const VOICE_BASE_URL = "https://rgai-letta.resonancegroupusa.com";
export const WHISPER_MODEL = "Systran/faster-whisper-medium.en";
export const KOKORO_VOICE = "bm_george";

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
  if (mode === "off") return "🔇 Off";
  if (mode === "tap") return "▶ Tap";
  return "🔊 Auto";
}

export async function transcribeVoice(uri: string, token: string): Promise<string> {
  const body = new FormData();
  body.append("model", WHISPER_MODEL);
  body.append("file", { uri, name: "milo-voice.m4a", type: "audio/mp4" } as never);
  const response = await fetch(`${VOICE_BASE_URL}/voice/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  if (!response.ok) throw new Error(`Voice transcription failed (${response.status})`);
  const payload = (await response.json()) as { text?: string } | string;
  const text = typeof payload === "string" ? payload : payload.text;
  if (!text?.trim()) throw new Error("Whisper returned an empty transcription.");
  return text.trim();
}

export function speechSource(text: string, token: string) {
  const clipped = text.slice(0, 12000);
  const query = new URLSearchParams({ text: clipped, voice: KOKORO_VOICE });
  return {
    uri: `${VOICE_BASE_URL}/voice/speech?${query.toString()}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}
