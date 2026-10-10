/**
 * Voice output profiles (issue #45).
 *
 * A profile maps a friendly label to a voice clip name understood by the
 * rgserver TTS backend (chatterbox-turbo /v1/voices) plus a per-profile
 * speech rate. Selection and rates persist locally on the phone; the active
 * profile's voice + speed ride every /voice/speech request as query params.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface VoiceProfileOption {
  id: string;
  label: string;
  /** Voice name the TTS backend accepts (clip filename or alias). */
  voice: string;
  /** Default speech rate; Julian runs at 90% cadence per Jason's tuning. */
  defaultSpeed: number;
}

export const VOICE_PROFILE_OPTIONS: VoiceProfileOption[] = [
  { id: "george", label: "George", voice: "elevenlabs_george_ref.mp3", defaultSpeed: 1.1 },
  { id: "daniel", label: "Daniel", voice: "elevenlabs_daniel_ref_v2.mp3", defaultSpeed: 1.1 },
  { id: "julian", label: "Julian", voice: "julian.wav", defaultSpeed: 0.9 },
];

export const VOICE_SPEED_MIN = 0.5;
export const VOICE_SPEED_MAX = 2.0;

const ACTIVE_KEY = "milo.voice.profile.v1";
const SPEED_KEY_PREFIX = "milo.voice.speed.v1.";

export interface VoiceSettings {
  activeId: string;
  speeds: Record<string, number>;
}

export function clampVoiceSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, rounded));
}

export function defaultVoiceSettings(): VoiceSettings {
  const speeds: Record<string, number> = {};
  for (const profile of VOICE_PROFILE_OPTIONS) speeds[profile.id] = profile.defaultSpeed;
  return { activeId: VOICE_PROFILE_OPTIONS[0].id, speeds };
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  const settings = defaultVoiceSettings();
  const savedActive = await AsyncStorage.getItem(ACTIVE_KEY);
  if (savedActive && VOICE_PROFILE_OPTIONS.some((p) => p.id === savedActive)) {
    settings.activeId = savedActive;
  }
  for (const profile of VOICE_PROFILE_OPTIONS) {
    const raw = await AsyncStorage.getItem(SPEED_KEY_PREFIX + profile.id);
    if (raw !== null) settings.speeds[profile.id] = clampVoiceSpeed(Number(raw));
  }
  return settings;
}

export async function saveActiveVoiceProfile(id: string): Promise<void> {
  if (VOICE_PROFILE_OPTIONS.some((p) => p.id === id)) {
    await AsyncStorage.setItem(ACTIVE_KEY, id);
  }
}

export async function saveVoiceSpeed(id: string, speed: number): Promise<void> {
  if (VOICE_PROFILE_OPTIONS.some((p) => p.id === id)) {
    await AsyncStorage.setItem(SPEED_KEY_PREFIX + id, String(clampVoiceSpeed(speed)));
  }
}

/** Voice name + speed the active profile resolves to for a TTS request. */
export function activeVoiceFor(settings: VoiceSettings): { voice: string; speed: number } {
  const profile = VOICE_PROFILE_OPTIONS.find((p) => p.id === settings.activeId) ?? VOICE_PROFILE_OPTIONS[0];
  return {
    voice: profile.voice,
    speed: clampVoiceSpeed(settings.speeds[profile.id] ?? profile.defaultSpeed),
  };
}
