import AsyncStorage from "@react-native-async-storage/async-storage";

const TRACE_KEY = "bloop.voice.trace.v1";
const MAX_TRACE_EVENTS = 160;

export interface VoiceTraceEvent {
  at: number;
  traceId: string;
  event: string;
  detail?: Record<string, unknown>;
}

let writeQueue: Promise<void> = Promise.resolve();

export function newVoiceTraceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function voiceTrace(traceId: string, event: string, detail?: Record<string, unknown>): void {
  const record: VoiceTraceEvent = { at: Date.now(), traceId, event, ...(detail ? { detail } : {}) };
  console.info("[bloop-voice-trace]", record);
  writeQueue = writeQueue.then(async () => {
    try {
      const raw = await AsyncStorage.getItem(TRACE_KEY);
      const prior = raw ? (JSON.parse(raw) as VoiceTraceEvent[]) : [];
      prior.push(record);
      await AsyncStorage.setItem(TRACE_KEY, JSON.stringify(prior.slice(-MAX_TRACE_EVENTS)));
    } catch {
      // Diagnostics must never perturb the voice path.
    }
  }, async () => {});
}

export async function replayPersistedVoiceTrace(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(TRACE_KEY);
    if (!raw) return;
    const events = JSON.parse(raw) as VoiceTraceEvent[];
    console.info("[bloop-voice-trace] persisted", events.slice(-80));
  } catch {
    // Best-effort diagnostics only.
  }
}
