/**
 * Chat — the product (docs/design-doc.md §4.4). A ChatSession bridges the
 * Agent SDK stream into the snapshot the transcript renders. The composer
 * stays enabled during a run (sends become queued follow-ups, server-
 * confirmed); the send button switches into stop.
 */
import { BottomSheetTextInput as NativeBottomSheetTextInput, type BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

const SheetTextInput = Platform.OS === "web" ? TextInput : NativeBottomSheetTextInput;
import { Image } from "expo-image";
import {
  RecordingPresets,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
} from "expo-audio";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import Svg, { Path } from "react-native-svg";

import { ApprovalCard } from "../components/chat/ApprovalCard";
import { ConnectionBanner } from "../components/chat/Banner";
import { ModelSheet } from "../components/chat/ModelSheet";
import { SecretSheet } from "../components/chat/SecretSheet";
import { QueueCapsule } from "../components/chat/QueueCapsule";
import { QueueSheet } from "../components/chat/QueueSheet";
import {
  AssistantBlock,
  ErrorRow,
  ReasoningRow,
  ThinkingRow,
  ToolCard,
  ToolGroupRow,
  UserBubble,
} from "../components/chat/TranscriptRows";
import { ToolDetailSheet } from "../components/chat/ToolDetailSheet";
import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { haptic } from "../lib/haptics";
import { ChatSession } from "../lib/letta/ChatSession";
import { isSecretSlashCommand } from "../lib/letta/secretCommands";
import {
  getConversationModel,
  isAuthError,
  listModels,
  renameConversation,
  updateConversationModel,
  type ConversationDiagnostics,
  type ModelOption,
  type ReasoningEffort,
} from "../lib/letta/api";
import {
  emptyChat,
  type ChatSnapshot,
  type ConnectionPhase,
  type PermissionMode,
  type ToolItem,
} from "../lib/letta/model";
import { groupToolRuns, type TranscriptRowItem } from "../lib/letta/grouping";
import { pickImages, type Attachment } from "../lib/letta/attachments";
import { completedAssistantReplies, newCompletedAssistantReplies } from "../lib/voiceEligibility";
import { getSecret } from "../lib/profiles/profiles";
import {
  getVoiceMode,
  nextVoiceMode,
  setVoiceMode as persistVoiceMode,
  speechSource,
  transcribeVoice,
  KOKORO_PLAYBACK_RATE,
  prepareSpeechText,
  voiceModeLabel,
  type VoiceMode,
  type TranscriptionProgress,
} from "../lib/voice";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radius, space } from "../theme/tokens";

const RUNTIME_PERMISSION_KEY_PREFIX = "milo.runtime.permission.v1:";
const RUNTIME_EFFORT_KEY_PREFIX = "milo.runtime.reasoning.v1:";
const VOICE_AUTO_SEND_KEY = "milo.voice.autoSend.v1";
const REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const VOICE_RECORDING_LIMIT_SECONDS = 10 * 60;

function permissionStorageKey(profileId: string): string {
  return `${RUNTIME_PERMISSION_KEY_PREFIX}${profileId}`;
}

function effortStorageKey(profileId: string, conversationId: string): string {
  return `${RUNTIME_EFFORT_KEY_PREFIX}${profileId}:${conversationId}`;
}

function dismissChatKeyboard(): void {
  if (Platform.OS === "web") {
    const active = globalThis.document?.activeElement as HTMLElement | null | undefined;
    active?.blur?.();
    return;
  }
  Keyboard.dismiss();
}

function savedReasoningEffort(value: string | null): ReasoningEffort | null {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : null;
}

function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function MicrophoneIcon({ color, size = 21 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V6.5a3.5 3.5 0 1 0-7 0V12a3.5 3.5 0 0 0 3.5 3.5Z" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5.8 11.7v.3a6.2 6.2 0 0 0 12.4 0v-.3M12 18.2V22M8.8 22h6.4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function SpeakerIcon({ color, muted = false, size = 19 }: { color: string; muted?: boolean; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 9.2h3.4L12 5.5v13l-4.6-3.7H4V9.2Z" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      {muted ? (
        <Path d="m16 9 5 5M21 9l-5 5" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      ) : (
        <Path d="M15.4 8.3a5 5 0 0 1 0 7.4M18.1 5.8a8.3 8.3 0 0 1 0 12.4" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      )}
    </Svg>
  );
}

function CloseIcon({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M6 6l12 12M18 6 6 18" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function CheckIcon({ color, size = 21 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="m5 12.5 4.2 4.2L19 7" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function SendIcon({ color = "#FFFFFF", size = 20 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Memoized so a streaming flush only re-renders the row whose item changed:
// upsertItem preserves untouched item identity, so reference equality holds.
const TranscriptRow = memo(function TranscriptRow({
  item,
  onUserRetry,
  onToolPress,
  onErrorRetry,
  onToggleGroup,
  onAssistantReplay,
}: {
  item: TranscriptRowItem;
  onUserRetry?: (id: string) => void;
  onToolPress?: (id: string) => void;
  onErrorRetry?: () => void;
  onToggleGroup?: (id: string) => void;
  onAssistantReplay?: (id: string, text: string) => void;
}) {
  switch (item.kind) {
    case "toolGroup":
      return (
        <ToolGroupRow group={item} onToggle={() => onToggleGroup?.(item.id)} />
      );
    case "user":
      return <UserBubble item={item} onRetry={onUserRetry ? () => onUserRetry(item.id) : undefined} />;
    case "assistant":
      return <AssistantBlock item={item} onVoiceReplay={onAssistantReplay && !item.streaming && !item.interrupted ? () => onAssistantReplay(item.id, item.text) : undefined} />;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "tool":
      return <ToolCard item={item} onPress={onToolPress ? () => onToolPress(item.id) : undefined} />;
    case "error":
      return <ErrorRow item={item} onRetry={onErrorRetry} />;
  }
});

function statusFor(
  run: ChatSnapshot["run"],
  connection: ConnectionPhase,
): { label: string; tone: "run" | "wait" | "danger" } {
  if (connection === "auth_failed") return { label: "Sign-in needed", tone: "danger" };
  if (connection === "offline") return { label: "Offline", tone: "danger" };
  if (connection === "reconnecting") return { label: "Reconnecting…", tone: "wait" };
  if (connection === "reconciling") return { label: "Catching up…", tone: "wait" };
  if (run === "running") return { label: "Running", tone: "run" };
  if (run === "aborting") return { label: "Stopping…", tone: "wait" };
  if (run === "awaiting_approval") return { label: "Waiting for you", tone: "wait" };
  return { label: "Connected", tone: "run" };
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ conversationId: string; agentId: string; agentName?: string; title?: string; autosend?: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { activeProfile } = useProfiles();

  const sessionRef = useRef<ChatSession | null>(null);
  const listRef = useRef<FlatList<TranscriptRowItem>>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({ ...emptyChat, hydrating: true });
  const [draft, setDraft] = useState("");
  // The nav param is only the title as it was when this screen was opened; a
  // rename (here or elsewhere) makes the server's value the truth.
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  // Collapsed tool runs the reader has opened (see lib/letta/grouping).
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>("tap");
  const [voiceModeLoaded, setVoiceModeLoaded] = useState(false);
  const [voiceAutoSend, setVoiceAutoSend] = useState(false);
  const [voiceAutoSendLoaded, setVoiceAutoSendLoaded] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [transcribingVoice, setTranscribingVoice] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceReply, setVoiceReply] = useState<{ id: string; text: string } | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState({ current: 0, duration: 0 });
  const voicePlayerRef = useRef<AudioPlayer | null>(null);
  const voicePlayerSubRef = useRef<{ remove(): void } | null>(null);
  const voicePlayRequestRef = useRef(0);
  const voiceHandledAssistantIdsRef = useRef(new Set<string>());
  const voiceHistorySeededRef = useRef(false);
  const voiceTrackWidthRef = useRef(0);
  const voiceDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);

  useEffect(() => {
    void getVoiceMode().then((mode) => {
      setVoiceModeState(mode);
      setVoiceModeLoaded(true);
    });
    void AsyncStorage.getItem(VOICE_AUTO_SEND_KEY).then((value) => {
      setVoiceAutoSend(value === "true");
      setVoiceAutoSendLoaded(true);
    }).catch(() => setVoiceAutoSendLoaded(true));
    return () => {
      if (voiceDismissTimerRef.current) clearTimeout(voiceDismissTimerRef.current);
      voicePlayRequestRef.current += 1;
      voicePlayerSubRef.current?.remove();
      try { voicePlayerRef.current?.pause(); } catch { /* already released */ }
      try { voicePlayerRef.current?.remove(); } catch { /* already released */ }
    };
  }, []);

  const retireVoicePlayer = useCallback((invalidatePendingStart = true) => {
    if (invalidatePendingStart) voicePlayRequestRef.current += 1;
    const player = voicePlayerRef.current;
    voicePlayerRef.current = null;
    voicePlayerSubRef.current?.remove();
    voicePlayerSubRef.current = null;
    // Native audio can outlive JS object disposal briefly. Pause first, then
    // remove, so dismiss/replacement is audible immediately and deterministic.
    if (player) {
      try { player.pause(); } catch { /* already released */ }
      try { player.remove(); } catch { /* already released */ }
    }
    setVoicePlaying(false);
    setVoiceProgress({ current: 0, duration: 0 });
  }, []);

  const clearVoiceDismissTimer = useCallback(() => {
    if (voiceDismissTimerRef.current) clearTimeout(voiceDismissTimerRef.current);
    voiceDismissTimerRef.current = null;
  }, []);

  const collapseVoiceReply = useCallback(() => {
    clearVoiceDismissTimer();
    retireVoicePlayer();
    setVoiceReply(null);
  }, [clearVoiceDismissTimer, retireVoicePlayer]);

  const scheduleVoiceReplyCollapse = useCallback((delayMs: number) => {
    clearVoiceDismissTimer();
    voiceDismissTimerRef.current = setTimeout(() => {
      voiceDismissTimerRef.current = null;
      retireVoicePlayer();
      setVoiceReply(null);
    }, delayMs);
  }, [clearVoiceDismissTimer, retireVoicePlayer]);

  const cycleVoiceMode = useCallback(() => {
    const next = nextVoiceMode(voiceMode);
    setVoiceModeState(next);
    void persistVoiceMode(next);
    if (next === "off") {
      clearVoiceDismissTimer();
      retireVoicePlayer();
      setVoiceReply(null);
    }
    haptic.tap();
  }, [voiceMode, retireVoicePlayer, clearVoiceDismissTimer]);

  const toggleVoiceAutoSend = useCallback(() => {
    const next = !voiceAutoSend;
    setVoiceAutoSend(next);
    void AsyncStorage.setItem(VOICE_AUTO_SEND_KEY, String(next));
    haptic.tap();
  }, [voiceAutoSend]);

  const startVoiceRecording = useCallback(async () => {
    if (!activeProfile || voiceRecording || transcribingVoice) return;
    setVoiceError(null);
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setVoiceError("Microphone permission is required for voice messages.");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
    setVoiceRecording(true);
    haptic.tap();
  }, [activeProfile, voiceRecording, transcribingVoice, recorder]);

  const cancelVoiceRecording = useCallback(async () => {
    try {
      if (recorderState.isRecording) await recorder.stop();
    } finally {
      setVoiceRecording(false);
      setVoiceError(null);
      await setAudioModeAsync({ allowsRecording: false });
    }
  }, [recorder, recorderState.isRecording]);

  const finishVoiceRecording = useCallback(async () => {
    if (!activeProfile) return;
    setVoiceError(null);
    try {
      if (recorderState.isRecording) await recorder.stop();
      setVoiceRecording(false);
      setTranscribingVoice(true);
      setTranscriptionProgress({ progress: 0, etaSeconds: null, elapsedSeconds: 0, audioDurationSeconds: recorderState.durationMillis / 1000, estimated: true });
      const uri = recorder.uri;
      if (!uri) throw new Error("The recording could not be saved.");
      const token = sessionRef.current?.authToken() ?? (await getSecret(activeProfile.id)) ?? "";
      if (!token) throw new Error("The Local Milo capability token is unavailable.");
      const text = await transcribeVoice(uri, token, activeProfile.url, {
        durationSeconds: recorderState.durationMillis / 1000,
        onProgress: setTranscriptionProgress,
      });
      if (voiceAutoSend) {
        const session = sessionRef.current;
        if (!session) throw new Error("Milo's chat session is not ready yet.");
        followLiveRef.current = true;
        nearBottomRef.current = true;
        setNearBottom(true);
        await session.send(text);
        requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
      } else {
        setDraft(text);
      }
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Voice transcription failed.");
    } finally {
      setTranscribingVoice(false);
      setTranscriptionProgress(null);
      await setAudioModeAsync({ allowsRecording: false });
    }
  }, [activeProfile, recorder, recorderState.isRecording, voiceAutoSend]);

  // `forDuration` enforces the ten-minute ceiling in native audio code. Once
  // that automatic stop is reflected back into recorder state, finalize it just
  // like the user tapped the check button so the recording is not stranded.
  useEffect(() => {
    if (!voiceRecording || recorderState.isRecording || recorderState.durationMillis < (VOICE_RECORDING_LIMIT_SECONDS * 1000 - 1000)) return;
    void finishVoiceRecording();
  }, [voiceRecording, recorderState.isRecording, recorderState.durationMillis, finishVoiceRecording]);

  const playVoiceText = useCallback(async (text: string) => {
    if (!activeProfile || !text.trim()) return;
    clearVoiceDismissTimer();

    // A voice start has async setup work before AVPlayer can be created. Retire
    // the current player immediately and invalidate any older start still in
    // flight so two clips can never survive that setup window together.
    const requestId = ++voicePlayRequestRef.current;
    const interruptedExistingClip = voicePlayerRef.current !== null;
    retireVoicePlayer(false);

    try {
      // A tiny gap makes an interruption perceptible instead of sounding like
      // two clips were spliced together, while the request id keeps old async
      // starts from surviving the pause.
      if (interruptedExistingClip) {
        await new Promise((resolve) => setTimeout(resolve, 90));
        if (requestId !== voicePlayRequestRef.current) return;
      }
      setVoiceError(null);
      // Playback should be reliable regardless of whether the microphone was
      // used first, and should remain audible with the iPhone silent switch on.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const token = sessionRef.current?.authToken() ?? (await getSecret(activeProfile.id)) ?? "";
      if (requestId !== voicePlayRequestRef.current) return;
      if (!token) throw new Error("The Local Milo capability token is unavailable.");
      const player = createAudioPlayer(speechSource(text, token, activeProfile.url), { updateInterval: 150 });
      if (requestId !== voicePlayRequestRef.current) {
        player.remove();
        return;
      }
      player.setPlaybackRate(KOKORO_PLAYBACK_RATE, "high");
      voicePlayerRef.current = player;
      voicePlayerSubRef.current = player.addListener("playbackStatusUpdate", (status) => {
        if (status.duration > 0) {
          setVoiceProgress({ current: status.currentTime || 0, duration: status.duration });
        }
        if (status.didJustFinish) {
          setVoicePlaying(false);
          scheduleVoiceReplyCollapse(0);
        }
      });
      player.play();
      setVoicePlaying(true);
    } catch (error) {
      if (requestId !== voicePlayRequestRef.current) return;
      setVoicePlaying(false);
      setVoiceError(error instanceof Error ? error.message : "Voice playback failed.");
    }
  }, [activeProfile, retireVoicePlayer, clearVoiceDismissTimer, scheduleVoiceReplyCollapse]);

  const toggleVoicePlayback = useCallback(() => {
    clearVoiceDismissTimer();
    const player = voicePlayerRef.current;
    if (player) {
      if (player.playing) {
        player.pause();
        setVoicePlaying(false);
      } else {
        const duration = player.duration || voiceProgress.duration;
        // Cards created against the old chunked TTS endpoint can have an
        // exhausted player with no duration. Recreate those against the now
        // seekable, range-enabled gateway instead of trying to resume a dead stream.
        if (duration <= 0 && player.currentTime > 0 && voiceReply) {
          voicePlayerSubRef.current?.remove();
          voicePlayerSubRef.current = null;
          player.remove();
          voicePlayerRef.current = null;
          void playVoiceText(voiceReply.text);
          return;
        }
        const atEnd = duration > 0 && player.currentTime >= duration - 0.15;
        const resume = async () => {
          if (atEnd) await player.seekTo(0);
          player.play();
          setVoicePlaying(true);
        };
        void resume();
      }
      return;
    }
    if (voiceReply) void playVoiceText(voiceReply.text);
  }, [voiceReply, voiceProgress.duration, playVoiceText, clearVoiceDismissTimer]);

  // Sample the native player's authoritative state for as long as the card has
  // a player. This avoids an early non-playing load event freezing the React
  // progress state even though native audio has actually started.
  useEffect(() => {
    if (!voiceReply) return;
    const timer = setInterval(() => {
      const player = voicePlayerRef.current;
      if (!player) return;
      setVoicePlaying(player.playing);
      setVoiceProgress({ current: player.currentTime || 0, duration: player.duration || 0 });
    }, 100);
    return () => clearInterval(timer);
  }, [voiceReply]);

  const seekVoiceReply = useCallback((fraction: number) => {
    clearVoiceDismissTimer();
    const player = voicePlayerRef.current;
    const duration = player?.duration || voiceProgress.duration;
    if (!player || !duration || !Number.isFinite(duration)) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    const nextTime = duration * clamped;
    setVoiceProgress({ current: nextTime, duration });
    void player.seekTo(nextTime);
  }, [voiceProgress.duration, clearVoiceDismissTimer]);

  const dismissVoiceReply = collapseVoiceReply;
  const attach = useCallback(async () => {
    haptic.tap();
    const picked = await pickImages();
    if (picked.length > 0) setAttachments((current) => [...current, ...picked].slice(0, 4));
  }, []);
  const nearBottomRef = useRef(true);
  // Live-follow is explicit user intent, not inferred from layout-generated
  // scroll events. Incoming tokens can move an inverted FlatList's offset even
  // when the reader never touched it; treating those events as a manual scroll
  // is what caused follow mode to switch itself off.
  const followLiveRef = useRef(true);
  const userScrollingRef = useRef(false);
  // Ignore scroll events briefly after our own jump-to-latest calls. Without
  // this, the browser/iOS can report an intermediate non-zero offset and make
  // a programmatic pin look like reader intent.
  const programmaticScrollUntilRef = useRef(0);
  const scrollToLatest = useCallback((animated: boolean) => {
    programmaticScrollUntilRef.current = Date.now() + 180;
    listRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);
  // Inverted list: the newest content lives at offset 0.
  const pinToLatest = useCallback(() => {
    userScrollingRef.current = false;
    followLiveRef.current = true;
    nearBottomRef.current = true;
    setNearBottom(true);
    scrollToLatest(true);
  }, [scrollToLatest]);

  // Dev-only: fire one real send after hydration, so live e2e flows can be
  // driven headlessly (deep link ?autosend=...). No-op in production builds.
  const autosentRef = useRef(false);
  useEffect(() => {
    if (!__DEV__ || !params.autosend || autosentRef.current) return;
    if (snapshot.hydrating || !sessionRef.current) return;
    autosentRef.current = true;
    const text = params.autosend;
    const timer = setTimeout(() => {
      haptic.send();
      sessionRef.current?.send(text).catch(() => {
        // Dev-only path; the transcript's error row already reports failures.
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [params.autosend, snapshot.hydrating]);

  // Drafts survive navigation and app restarts (per-conversation key).
  const draftKey = `letta.draft.${params.conversationId}`;
  // Mirrors `draft` so teardown can flush the newest value without making the
  // debounce effect depend on every keystroke.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // A restore that lands after the user starts typing must not clobber them.
  const draftTouched = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(draftKey).then((saved) => {
      if (cancelled || !saved || draftTouched.current) return;
      if (isSecretSlashCommand(saved)) {
        // A secret command belongs in the secure manager, never draft storage.
        void AsyncStorage.removeItem(draftKey);
        return;
      }
      setDraft(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isSecretSlashCommand(draftRef.current)) void AsyncStorage.removeItem(draftKey);
      else void AsyncStorage.setItem(draftKey, draftRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);
  // Unmount can beat the debounce; persist the last keystrokes synchronously.
  useEffect(
    () => () => {
      if (isSecretSlashCommand(draftRef.current)) void AsyncStorage.removeItem(draftKey);
      else void AsyncStorage.setItem(draftKey, draftRef.current);
    },
    [draftKey],
  );
  const clearDraft = useCallback(() => {
    draftTouched.current = false;
    setDraft("");
    void AsyncStorage.removeItem(draftKey);
  }, [draftKey]);
  const editDraft = useCallback((next: string) => {
    draftTouched.current = true;
    setDraft(next);
  }, []);

  // Conversation-scoped model + reasoning controls.
  const modelSheetRef = useRef<BottomSheetModal>(null);
  const queueSheetRef = useRef<BottomSheetModal>(null);
  const controlsSheetRef = useRef<BottomSheetModal>(null);
  const secretSheetRef = useRef<BottomSheetModal>(null);
  const conversationStatusSheetRef = useRef<BottomSheetModal>(null);
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const [conversationDiagnostics, setConversationDiagnostics] = useState<ConversationDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [compactingConversation, setCompactingConversation] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingConversation, setRenamingConversation] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // Prevent an async model refresh that started before a user selection from
  // overwriting the newer choice when its stale response arrives later.
  const modelSettingRevisionRef = useRef(0);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState<"allow" | "deny" | undefined>();

  const refreshConversationDiagnostics = useCallback(async () => {
    if (!activeProfile || !params.conversationId) return;
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const session = sessionRef.current;
      if (!session) throw new Error("Milo session is not ready yet.");
      setConversationDiagnostics(await session.getConversationDiagnostics());
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : "Couldn't load conversation status.");
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [activeProfile, params.conversationId]);

  const openConversationStatus = useCallback(() => {
    dismissChatKeyboard();
    conversationStatusSheetRef.current?.present();
    void refreshConversationDiagnostics();
  }, [refreshConversationDiagnostics]);

  const openRenameConversation = useCallback(() => {
    setRenameDraft(serverTitle ?? params.title ?? "");
    conversationStatusSheetRef.current?.dismiss();
    setTimeout(() => renameSheetRef.current?.present(), 180);
  }, [serverTitle, params.title]);

  const submitConversationRename = useCallback(async () => {
    const nextTitle = renameDraft.trim();
    if (!activeProfile || !params.conversationId || !nextTitle || renamingConversation) return;
    setRenamingConversation(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await renameConversation({ profile: activeProfile, secret }, params.conversationId, nextTitle);
      setServerTitle(nextTitle);
      renameSheetRef.current?.dismiss();
    } catch (error) {
      Alert.alert("Couldn't rename", error instanceof Error ? error.message : undefined);
    } finally {
      setRenamingConversation(false);
    }
  }, [activeProfile, params.conversationId, renameDraft, renamingConversation]);

  const requestConversationCompaction = useCallback(() => {
    if (!activeProfile || !params.conversationId || compactingConversation) return;
    if (snapshot.run === "running" || snapshot.run === "awaiting_approval" || snapshot.run === "aborting") {
      setDiagnosticsError("Finish the current Milo run before compacting this conversation.");
      return;
    }
    Alert.alert(
      "Compact conversation?",
      "Milo will summarize the current in-context message history to free context-window space. The chat transcript remains available.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compact",
          onPress: () => {
            void (async () => {
              setCompactingConversation(true);
              setDiagnosticsError(null);
              try {
                const session = sessionRef.current;
                if (!session) throw new Error("Milo session is not ready yet.");
                await session.compactConversation();
                await session.reconnect();
                await refreshConversationDiagnostics();
              } catch (error) {
                setDiagnosticsError(error instanceof Error ? error.message : "Couldn't compact the conversation.");
              } finally {
                setCompactingConversation(false);
              }
            })();
          },
        },
      ],
    );
  }, [activeProfile, params.conversationId, compactingConversation, snapshot.run, refreshConversationDiagnostics]);

  // Tool detail sheet: track the id, not the item — the open sheet keeps
  // receiving live status/result updates from the snapshot.
  const toolSheetRef = useRef<BottomSheetModal>(null);
  const [detailToolId, setDetailToolId] = useState<string | null>(null);
  const detailTool = useMemo(
    () =>
      (snapshot.transcript.find((t): t is ToolItem => t.kind === "tool" && t.id === detailToolId) ?? null),
    [snapshot.transcript, detailToolId],
  );
  const onToolPress = useCallback((id: string) => {
    setDetailToolId(id);
    dismissChatKeyboard();
    toolSheetRef.current?.present();
  }, []);

  // The submitting label clears only when the session settles the decision —
  // confirmation, timeout, or stream failure (never same-render).
  const submitApproval = useCallback(
    (requestId: string, decision: "allow" | "deny", reason?: string, suggestionId?: string) => {
      const session = sessionRef.current;
      if (!session) return;
      setApprovalSubmitting(decision);
      void session
        .resolveApproval(requestId, decision, reason, suggestionId)
        .finally(() => setApprovalSubmitting(undefined));
    },
    [],
  );

  // Session lifecycle — one ChatSession per open conversation.
  useEffect(() => {
    if (!activeProfile || !params.conversationId) return;
    let cancelled = false;
    let opened: ChatSession | null = null;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        const [secretValue, savedPermission] = await Promise.all([
          getSecret(activeProfile.id),
          AsyncStorage.getItem(permissionStorageKey(activeProfile.id)),
        ]);
        const secret = secretValue ?? "";
        const initialPermissionMode =
          savedPermission && ["strict", "standard", "acceptEdits", "unrestricted"].includes(savedPermission)
            ? (savedPermission as PermissionMode)
            : undefined;
        const session = ChatSession.open(
          { profile: activeProfile, secret },
          params.conversationId,
          initialPermissionMode,
        );
        opened = session;
        if (cancelled) {
          session.releaseView();
          return;
        }
        sessionRef.current = session;
        // Scrolling belongs to the list's onContentSizeChange, not here: a
        // snapshot-time scroll races layout, since the hydration batch measures
        // after the scroll fires.
        unsubscribe = session.subscribe(setSnapshot);
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            ...emptyChat,
            hydrating: false,
            connection: isAuthError(error) ? "auth_failed" : "offline",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      opened?.releaseView();
      if (sessionRef.current === opened) sessionRef.current = null;
    };
  }, [activeProfile, params.conversationId]);

  // The saved permission mode is loaded before ChatSession.open(), so it is
  // part of runtime_start and pending approval recovery on a cold open. Explicit
  // user changes still flow through setPermissionMode() below.

  // Load the current conversation model once hydration settles — on remote,
  // concurrent control-channel connections collide (single-slot app-server).
  useEffect(() => {
    if (!activeProfile || !params.conversationId || snapshot.hydrating) return;
    // Remote reads go through the session's own connection (the app-server
    // accepts one control client); wait briefly for the session ref, which is
    // set by the sibling effect. Cloud reads are plain REST.
    const timer = setTimeout(async () => {
      const readRevision = modelSettingRevisionRef.current;
      try {
        let current: { model: string | null; reasoningEffort: string | null; title: string | null };
        if (activeProfile.type === "remote") {
          for (let attempt = 0; !sessionRef.current && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!sessionRef.current) return;
          current = await sessionRef.current.getModelInfo();
        } else {
          current = await getConversationModel(
            { profile: activeProfile, secret: (await getSecret(activeProfile.id)) ?? "" },
            params.conversationId,
          );
        }
        if (readRevision !== modelSettingRevisionRef.current) return;
        setModel(current.model);
        const serverEffort = savedReasoningEffort(current.reasoningEffort);
        const persistedEffort = savedReasoningEffort(
          await AsyncStorage.getItem(effortStorageKey(activeProfile.id, params.conversationId)),
        );
        // Server/conversation state is authoritative. Local storage is only a
        // fallback for backends that genuinely do not report an effort tier.
        const effectiveEffort = serverEffort ?? persistedEffort;
        setEffort(effectiveEffort);
        if (serverEffort) {
          void AsyncStorage.setItem(
            effortStorageKey(activeProfile.id, params.conversationId),
            serverEffort,
          );
        }
        if (current.title) setServerTitle(current.title);
      } catch {
        // Chip falls back to "model" affordance; sheet still works.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeProfile, params.conversationId, snapshot.hydrating, snapshot.connection]);

  const openModelSheet = useCallback(async () => {
    if (!activeProfile || !params.conversationId) return;
    setModelError(null);
    modelSheetRef.current?.present();
    const readRevision = modelSettingRevisionRef.current;

    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const [freshModels, current] = await Promise.all([
        models.length === 0
          ? listModels({ profile: activeProfile, secret })
          : Promise.resolve(models),
        activeProfile.type === "remote" && sessionRef.current
          ? sessionRef.current.getModelInfo()
          : getConversationModel(
              { profile: activeProfile, secret },
              params.conversationId,
            ),
      ]);

      if (models.length === 0) setModels(freshModels);
      if (readRevision !== modelSettingRevisionRef.current) return;
      setModel(current.model);
      const serverEffort = savedReasoningEffort(current.reasoningEffort);
      const persistedEffort = savedReasoningEffort(
        await AsyncStorage.getItem(effortStorageKey(activeProfile.id, params.conversationId)),
      );
      const effectiveEffort = serverEffort ?? persistedEffort;
      setEffort(effectiveEffort);
      if (serverEffort) {
        void AsyncStorage.setItem(
          effortStorageKey(activeProfile.id, params.conversationId),
          serverEffort,
        );
      }
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "Couldn't refresh model settings.");
    }
  }, [activeProfile, params.conversationId, models]);

  const selectModel = useCallback(
    async (handle: string, nextEffort?: ReasoningEffort) => {
      if (!activeProfile || !params.conversationId) return;
      modelSettingRevisionRef.current += 1;
      modelSheetRef.current?.dismiss();
      const previous = { model, effort };
      setModel(handle);
      if (nextEffort) {
        setEffort(nextEffort);
        void AsyncStorage.setItem(effortStorageKey(activeProfile.id, params.conversationId), nextEffort);
      }
      setModelSaving(true);
      try {
        if (activeProfile.type === "remote") {
          for (let attempt = 0; !sessionRef.current && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!sessionRef.current) throw new Error("Milo's model session is still reconnecting.");
          await sessionRef.current.setModel(handle, nextEffort);
        } else {
          const secret = (await getSecret(activeProfile.id)) ?? "";
          await updateConversationModel({ profile: activeProfile, secret }, params.conversationId, {
            model: handle,
            ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
          });
        }
      } catch (e) {
        setModel(previous.model);
        setEffort(previous.effort);
        setModelError(e instanceof Error ? e.message : "Couldn't change the model.");
        modelSheetRef.current?.present();
      } finally {
        setModelSaving(false);
      }
    },
    [activeProfile, params.conversationId, model, effort],
  );

  const selectEffort = useCallback(
    async (nextEffort: ReasoningEffort) => {
      if (!activeProfile || !params.conversationId) return;
      modelSettingRevisionRef.current += 1;
      const previous = effort;
      setEffort(nextEffort);
      // Persist the user's choice even if model metadata is still loading. The
      // old handler returned early when `model` was null, so the sheet painted a
      // local selection that vanished the next time it opened.
      await AsyncStorage.setItem(effortStorageKey(activeProfile.id, params.conversationId), nextEffort);
      setModelSaving(true);
      setModelError(null);
      try {
        let targetModel = model;
        if (!targetModel) {
          const secret = (await getSecret(activeProfile.id)) ?? "";
          const current =
            activeProfile.type === "remote" && sessionRef.current
              ? await sessionRef.current.getModelInfo()
              : await getConversationModel(
                  { profile: activeProfile, secret },
                  params.conversationId,
                );
          targetModel = current.model;
          if (targetModel) setModel(targetModel);
        }
        if (!targetModel) throw new Error("The current model is still unavailable.");

        if (activeProfile.type === "remote") {
          // Local/App-Server models can have provider mods (for Milo, `vllm`)
          // whose reasoning settings cannot be safely synthesized by the generic
          // REST updater. Wait for the real session and let the App Server apply
          // the catalog-backed reasoning tier.
          for (let attempt = 0; !sessionRef.current && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!sessionRef.current) throw new Error("Milo's model session is still reconnecting.");
          await sessionRef.current.setModel(targetModel, nextEffort);
        } else {
          const secret = (await getSecret(activeProfile.id)) ?? "";
          await updateConversationModel({ profile: activeProfile, secret }, params.conversationId, {
            model: targetModel,
            reasoningEffort: nextEffort,
          });
        }
      } catch (e) {
        setEffort(previous);
        setModelError(e instanceof Error ? e.message : "Couldn't change reasoning effort.");
      } finally {
        setModelSaving(false);
      }
    },
    [activeProfile, params.conversationId, model, effort],
  );

  const running = snapshot.run === "running" || snapshot.run === "awaiting_approval";
  const aborting = snapshot.run === "aborting";
  useEffect(() => {
    if (!(running || aborting || voiceRecording || transcribingVoice)) return;

    const tag = "local-milo-active-run";
    let disposed = false;
    let activated = false;

    // Expo rejects deactivation for a tag that never successfully activated.
    // Keep activation ownership inside this effect instance so a fast state
    // transition cannot race activateKeepAwakeAsync() and produce an unhandled
    // wake-lock error during chat startup/recovery.
    void activateKeepAwakeAsync(tag)
      .then(() => {
        activated = true;
        if (disposed) void deactivateKeepAwake(tag).catch(() => {});
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (activated) void deactivateKeepAwake(tag).catch(() => {});
    };
  }, [running, aborting, voiceRecording, transcribingVoice]);

  useEffect(() => {
    const completedAssistants = completedAssistantReplies(snapshot.transcript);

    // Hydration/catch-up replays historical transcript rows into a fresh screen.
    // Seed those stable ids before observing live completions so opening or
    // reconnecting a conversation can never make old replies speak again.
    if (snapshot.hydrating) {
      for (const item of completedAssistants) voiceHandledAssistantIdsRef.current.add(item.id);
      return;
    }
    if (!voiceHistorySeededRef.current) {
      for (const item of completedAssistants) voiceHandledAssistantIdsRef.current.add(item.id);
      voiceHistorySeededRef.current = true;
      return;
    }
    if (!voiceModeLoaded) return;

    // Voice follows completed assistant prose, not the run lifecycle. Milo can
    // emit a useful assistant message and then continue into more tool calls;
    // that completed message is independently voice-eligible as soon as it lands.
    const newlyCompleted = newCompletedAssistantReplies(
      snapshot.transcript,
      voiceHandledAssistantIdsRef.current,
    );
    if (newlyCompleted.length === 0) return;
    for (const item of newlyCompleted) voiceHandledAssistantIdsRef.current.add(item.id);

    if (voiceMode === "off") return;

    // A reconnect/catch-up can deliver several newly completed rows in one
    // render. Surface only the newest rather than firing a burst of stale audio;
    // under normal live streaming there is one newly completed row at a time.
    const reply = newlyCompleted[newlyCompleted.length - 1];
    const speakableText = prepareSpeechText(reply.text);
    clearVoiceDismissTimer();
    retireVoicePlayer();
    if (!speakableText) {
      setVoiceReply(null);
      return;
    }

    setVoiceReply({ id: reply.id, text: speakableText });
    if (voiceMode === "auto") {
      void playVoiceText(speakableText);
    } else {
      scheduleVoiceReplyCollapse(15000);
    }
  }, [
    snapshot.hydrating,
    snapshot.transcript,
    voiceMode,
    voiceModeLoaded,
    playVoiceText,
    retireVoicePlayer,
    clearVoiceDismissTimer,
    scheduleVoiceReplyCollapse,
  ]);

  const refreshAgentSecrets = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !params.agentId) return;
    setSecretLoading(true);
    setSecretError(null);
    try {
      setSecretNames(await session.listAgentSecretNames(params.agentId));
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : "Could not load agent secrets.");
    } finally {
      setSecretLoading(false);
    }
  }, [params.agentId]);

  const openSecretManager = useCallback(() => {
    // Present first so a slow remote refresh never makes the command look ignored.
    secretSheetRef.current?.present();
    void refreshAgentSecrets();
  }, [refreshAgentSecrets]);

  const applyAgentSecrets = useCallback(
    async (set: Record<string, string>, unset: string[]) => {
      const session = sessionRef.current;
      if (!session || !params.agentId) throw new Error("Agent session is unavailable.");
      setSecretError(null);
      const names = await session.applyAgentSecrets(params.agentId, set, unset);
      setSecretNames(names);
    },
    [params.agentId],
  );

  const interceptSecretCommand = useCallback(
    (text: string): boolean => {
      if (!isSecretSlashCommand(text)) return false;
      // Never parse a value from `/secret set KEY value`: discard the entire
      // composer command and make the user enter it in secureTextEntry instead.
      clearDraft();
      openSecretManager();
      haptic.tap();
      return true;
    },
    [clearDraft, openSecretManager],
  );

  const onPrimaryAction = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (running) {
      haptic.stop();
      await session.abort();
      return;
    }
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (text && interceptSecretCommand(text)) return;
    dismissChatKeyboard();
    haptic.send();
    const images = attachments;
    setAttachments([]);
    clearDraft();
    // Sending always re-enters follow mode — your own message must be visible.
    pinToLatest();
    await session.send(text, images);
  }, [running, draft, attachments, pinToLatest, clearDraft, interceptSecretCommand]);

  const sendWhileRunning = useCallback(async () => {
    const session = sessionRef.current;
    const text = draft.trim();
    if (!session || (!text && attachments.length === 0)) return;
    if (text && interceptSecretCommand(text)) return;
    dismissChatKeyboard();
    haptic.queue();
    const images = attachments;
    setAttachments([]);
    clearDraft();
    pinToLatest();
    await session.send(text, images);
  }, [draft, attachments, pinToLatest, clearDraft, interceptSecretCommand]);

  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const onComposerKeyPress = useCallback((event: any) => {
    if (Platform.OS !== "web" || event?.nativeEvent?.key !== "Enter") return;
    const native = event.nativeEvent ?? {};
    const shift = Boolean(native.shiftKey ?? event.shiftKey);
    const composing = Boolean(native.isComposing ?? event.isComposing);
    if (shift || composing) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (!canSend || snapshot.hydrating || aborting) return;
    if (running) {
      void sendWhileRunning();
    } else {
      void onPrimaryAction();
    }
  }, [canSend, snapshot.hydrating, aborting, running, sendWhileRunning, onPrimaryAction]);
  const agentName = params.agentName ?? "Agent";
  const title = serverTitle ?? params.title ?? "Conversation";

  // Inverted-list data (references do chat this way — e.g. paseo's native
  // strategy): the visual bottom is offset 0, so new content pins natively
  // and keyboard/layout changes can't break "near bottom" tracking.
  const listData = useMemo(() => {
    // Keep the active turn structurally stable while it streams. Collapsing a
    // growing run of settled tool cards into a ToolGroup changes several row
    // keys/heights at once and can move a reader who is inspecting older text.
    // Historical turns remain grouped; only the latest in-progress turn stays
    // expanded until it settles.
    if (running) {
      let latestUser = -1;
      for (let i = snapshot.transcript.length - 1; i >= 0; i--) {
        if (snapshot.transcript[i]?.kind === "user") {
          latestUser = i;
          break;
        }
      }
      if (latestUser >= 0) {
        return [
          ...groupToolRuns(snapshot.transcript.slice(0, latestUser), expandedGroups),
          ...snapshot.transcript.slice(latestUser),
        ].reverse();
      }
    }
    return groupToolRuns(snapshot.transcript, expandedGroups).reverse();
  }, [snapshot.transcript, expandedGroups, running]);
  const onToggleGroup = useCallback((id: string) => {
    haptic.tap();
    setExpandedGroups((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onUserRetry = useCallback(
    (id: string) => {
      haptic.send();
      void sessionRef.current?.retrySend(id);
      pinToLatest();
    },
    [pinToLatest],
  );
  const onErrorRetry = useCallback(() => {
    haptic.tap();
    void sessionRef.current?.reconnect();
  }, []);

  const onAssistantReplay = useCallback((id: string, markdown: string) => {
    const text = prepareSpeechText(markdown);
    if (!text) return;
    clearVoiceDismissTimer();
    retireVoicePlayer();
    setVoiceReply({ id, text });
    void playVoiceText(text);
  }, [clearVoiceDismissTimer, retireVoicePlayer, playVoiceText]);

  // Stable renderItem keeps TranscriptRow's memo effective across flushes.
  const renderItem = useCallback(
    ({ item }: { item: TranscriptRowItem }) => (
      <TranscriptRow
        item={item}
        onUserRetry={onUserRetry}
        onToolPress={onToolPress}
        onErrorRetry={onErrorRetry}
        onToggleGroup={onToggleGroup}
        onAssistantReplay={voiceMode !== "off" ? onAssistantReplay : undefined}
      />
    ),
    [onUserRetry, onToolPress, onErrorRetry, onToggleGroup, voiceMode, onAssistantReplay],
  );

  // Between send-accepted and the first streamed token there is no transcript
  // activity — show a breathing "Thinking…" row so the turn never looks dead.
  const lastItem = snapshot.transcript[snapshot.transcript.length - 1];
  const streamingNow =
    (lastItem?.kind === "assistant" || lastItem?.kind === "reasoning") && lastItem.streaming;
  const toolActive = lastItem?.kind === "tool" && (lastItem.status === "running" || lastItem.status === "pending");
  const waitingForModel = running && !streamingNow && !toolActive;

  // Transient link states read as "working", not "broken" — only a genuine
  // loss of connectivity or bad credentials earns the danger tone.
  const status = statusFor(snapshot.run, snapshot.connection);

  return (
    <Screen>
      <Header
        title={title}
        back
        subtitle={
          <View style={styles.statusRow}>
            <Text role="sub" ink={2}>
              {agentName} · {status.label}
            </Text>
            <StatusDot tone={status.tone} />
          </View>
        }
        onTitlePress={openConversationStatus}
        titleAccessibilityLabel="Conversation status and context usage"
        trailing={
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Voice output: ${voiceMode}. Tap to change`}
            onPress={cycleVoiceMode}
            style={[styles.voiceModePill, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
          >
            <View style={styles.voiceModeContent}>
              <SpeakerIcon
                color={voiceMode === "auto" ? colors.accent : colors.ink2}
                muted={voiceMode === "off"}
              />
              <Text role="sub" tone={voiceMode === "auto" ? "accent" : undefined}>
                {voiceModeLabel(voiceMode)}
              </Text>
            </View>
          </Touchable>
        }
      />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <View style={styles.flex}>
          {snapshot.hydrating ? (
            <SkeletonList rows={4} avatar={false} />
          ) : (
            <FlatList
            ref={listRef}
            data={listData}
            inverted
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.transcript}
            // Virtualization tuned like paseo's native strategy: enough rows
            // up front that a fast scroll into history doesn't blank, and a
            // wide window so streaming flushes never evict nearby cells.
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={21}
            // Inverted list: offset 0 IS the newest content, so being at the
            // bottom survives keyboard/layout changes, and pinning while
            // streaming is native. A reader who scrolled up keeps their place
            // (maintainVisibleContentPosition); Android ignores it under the
            // inversion transform, so iOS-only — same trade the references make.
            maintainVisibleContentPosition={
              // Keep this configuration stable. Toggling the prop itself while
              // rows are measuring can cause an inverted FlatList to jump.
              // While following live, onContentSizeChange explicitly pins offset 0.
              Platform.OS === "ios" ? { minIndexForVisible: 0 } : undefined
            }
            // maintainVisibleContentPosition keeps a scrolled-up reader in place
            // but does not guarantee the live edge stays pinned once a hydration
            // batch measures, so re-pin explicitly for a reader who is following.
            onContentSizeChange={() => {
              if (!userScrollingRef.current && followLiveRef.current) {
                // While following, growth belongs below the reader. Keep the
                // visual live edge pinned instead of preserving the old cell.
                scrollToLatest(false);
              }
            }}
            // Visual bottom, above the composer — shows while the model has
            // accepted the send but nothing has streamed back yet.
            ListHeaderComponent={waitingForModel ? <ThinkingRow /> : null}
            // Inverted list: the "end" is the visual top, so this is where
            // reaching the oldest loaded row asks for the previous page.
            onEndReached={() => void sessionRef.current?.loadOlder()}
            onEndReachedThreshold={0.2}
            ListFooterComponent={
              snapshot.loadingOlder ? (
                <View style={styles.olderSpinner}>
                  <ActivityIndicator size="small" color={colors.ink3} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.invertedEmpty}>
                <EmptyState message={`No messages yet. Say hello to ${agentName}.`} />
              </View>
            }
            // Dragging the transcript pulls the keyboard down with the gesture.
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => {
              // Manual interaction freezes live-follow immediately. Layout and
              // programmatic scroll events never enter this path.
              userScrollingRef.current = true;
              followLiveRef.current = false;
              dismissChatKeyboard();
            }}
            onMomentumScrollBegin={() => {
              userScrollingRef.current = true;
            }}
            onScrollEndDrag={(e) => {
              const offset = Math.max(0, e.nativeEvent.contentOffset.y);
              const nearBottom = offset < 80;
              const atLiveEdge = offset <= 2;
              nearBottomRef.current = nearBottom;
              setNearBottom(nearBottom);
              // A manual drag disables follow immediately. Do not silently turn
              // it back on merely because the reader stopped *near* the bottom;
              // only returning to the actual live edge opts back into follow.
              followLiveRef.current = atLiveEdge;
              userScrollingRef.current = false;
            }}
            onMomentumScrollEnd={(e) => {
              const offset = Math.max(0, e.nativeEvent.contentOffset.y);
              const nearBottom = offset < 80;
              const atLiveEdge = offset <= 2;
              nearBottomRef.current = nearBottom;
              setNearBottom(nearBottom);
              followLiveRef.current = atLiveEdge;
              userScrollingRef.current = false;
              if (atLiveEdge) scrollToLatest(false);
            }}
            onScroll={(e) => {
              const offset = Math.max(0, e.nativeEvent.contentOffset.y);
              const nearBottom = offset < 80;
              nearBottomRef.current = nearBottom;
              setNearBottom(nearBottom);

              // Browser wheel/trackpad scrolling does not reliably fire
              // onScrollBeginDrag, and iOS can finish the drag callback before
              // all movement settles. Treat moving materially away from offset 0
              // as reader intent unless it immediately follows one of our own
              // programmatic pins. This makes manual scroll position authoritative
              // while content continues streaming.
              if (Date.now() < programmaticScrollUntilRef.current) return;
              if (offset > 6) {
                followLiveRef.current = false;
                return;
              }
              // Only an active reader gesture can opt back into live-follow;
              // layout/content changes reaching zero must not silently do it.
              if (userScrollingRef.current && offset <= 2) {
                followLiveRef.current = true;
              }
            }}
            scrollEventThrottle={16}
            />
          )}
          {/* Anchored to the list's own bottom edge, so it clears the composer
              at any height and never lands on the transcript's newest row. */}
          {!nearBottom ? (
            <Animated.View
              entering={FadeIn.duration(motion.micro.duration)}
              exiting={FadeOut.duration(motion.micro.duration)}
              style={styles.latestWrap}
              pointerEvents="box-none"
            >
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Jump to latest"
                onPress={pinToLatest}
                style={[styles.latest, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
              >
                <Text role="sub" ink={2}>
                  ↓ Latest
                </Text>
              </Touchable>
            </Animated.View>
          ) : null}
        </View>

        <View
          style={[
            styles.composerWrap,
            { borderColor: colors.surfaceEdge, paddingBottom: Math.max(insets.bottom, space.md) },
          ]}
        >
          {snapshot.connection !== "connected" ? (
            <ConnectionBanner
              phase={snapshot.connection}
              target={activeProfile?.name}
              onRetry={() => void sessionRef.current?.reconnect()}
              onEditProfile={() => router.push("/profile")}
            />
          ) : null}
          <QueueCapsule
            queue={snapshot.queue}
            onPress={() => {
              dismissChatKeyboard();
              queueSheetRef.current?.present();
            }}
          />
          {snapshot.approvals[0] ? (
            <ApprovalCard
              request={snapshot.approvals[0]}
              position={
                snapshot.approvals.length > 1 ? { index: 1, total: snapshot.approvals.length } : undefined
              }
              cwd={snapshot.device?.workingDirectory}
              submitting={approvalSubmitting}
              onAllow={(reason) => submitApproval(snapshot.approvals[0]!.requestId, "allow", reason)}
              onDeny={(reason) => submitApproval(snapshot.approvals[0]!.requestId, "deny", reason)}
              onAcceptSuggestion={(suggestionId) =>
                submitApproval(snapshot.approvals[0]!.requestId, "allow", undefined, suggestionId)
              }
            />
          ) : null}
          {attachments.length > 0 && snapshot.approvals.length === 0 ? (
            <View style={styles.attachRow}>
              {attachments.map((a) => (
                <Touchable
                  key={a.id}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attachment"
                  onPress={() => setAttachments((current) => current.filter((c) => c.id !== a.id))}
                  style={styles.attachChip}
                >
                  <Image source={{ uri: a.uri }} style={styles.attachThumb} contentFit="cover" />
                  <View style={[styles.attachRemove, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
                    <Text role="micro" ink={2}>
                      ✕
                    </Text>
                  </View>
                </Touchable>
              ))}
            </View>
          ) : null}
          {voiceRecording || transcribingVoice ? (
            <View style={[styles.voiceRecorderPanel, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
              {transcribingVoice ? (
                <>
                  <Text role="bodyEm" tone="accent">Transcribing…</Text>
                  <Text role="title">{Math.round((transcriptionProgress?.progress ?? 0) * 100)}%</Text>
                  <View
                    accessibilityRole="progressbar"
                    accessibilityValue={{ min: 0, max: 100, now: Math.round((transcriptionProgress?.progress ?? 0) * 100) }}
                    style={[styles.transcriptionTrack, { backgroundColor: colors.surfaceEdge }]}
                  >
                    <View
                      style={[
                        styles.transcriptionFill,
                        {
                          backgroundColor: colors.accent,
                          width: `${Math.max(0, Math.min(100, (transcriptionProgress?.progress ?? 0) * 100))}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text role="sub" ink={2}>
                    {transcriptionProgress?.etaSeconds === null || transcriptionProgress?.etaSeconds === undefined
                      ? "Estimating time remaining…"
                      : transcriptionProgress.etaSeconds > 0
                        ? `Estimated ~${Math.max(1, Math.ceil(transcriptionProgress.etaSeconds))} sec remaining`
                        : "Finishing transcription…"}
                  </Text>
                </>
              ) : (
                <>
                  <Text role="bodyEm" tone="accent">Listening…</Text>
                  <Text role="title">{Math.floor(recorderState.durationMillis / 60000).toString().padStart(2, "0")}:{Math.floor((recorderState.durationMillis % 60000) / 1000).toString().padStart(2, "0")}</Text>
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={`Auto-send voice transcription ${voiceAutoSend ? "on" : "off"}`}
                    onPress={toggleVoiceAutoSend}
                    disabled={!voiceAutoSendLoaded}
                    style={[
                      styles.voiceAutoSendPill,
                      {
                        backgroundColor: voiceAutoSend ? colors.bubble : colors.surface,
                        borderColor: voiceAutoSend ? colors.accent : colors.surfaceEdge,
                        opacity: voiceAutoSendLoaded ? 1 : 0.5,
                      },
                    ]}
                  >
                    <StatusDot tone={voiceAutoSend ? "run" : "idle"} />
                    <Text role="sub" tone={voiceAutoSend ? "accent" : undefined}>Auto-send</Text>
                  </Touchable>
                  <View style={styles.waveform}>
                    {Array.from({ length: 24 }, (_, index) => {
                      const level = Math.max(0.15, Math.min(1, ((recorderState.metering ?? -52) + 60) / 42));
                      const shape = 0.35 + ((index * 7) % 11) / 16;
                      return <View key={index} style={[styles.waveBar, { backgroundColor: colors.accent, height: 8 + 30 * level * shape }]} />;
                    })}
                  </View>
                  <View style={styles.voiceRecorderActions}>
                    <Touchable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel voice recording"
                      onPress={() => void cancelVoiceRecording()}
                      style={[styles.voiceActionIcon, { backgroundColor: colors.bubble, borderColor: colors.surfaceEdge }]}
                    >
                      <CloseIcon color={colors.ink2} />
                    </Touchable>
                    <Touchable
                      accessibilityRole="button"
                      accessibilityLabel="Use voice recording"
                      onPress={() => void finishVoiceRecording()}
                      style={[styles.voiceActionIcon, { backgroundColor: colors.accent, borderColor: colors.accent }]}
                    >
                      <CheckIcon color="#FFFFFF" />
                    </Touchable>
                  </View>
                </>
              )}
            </View>
          ) : null}
          {voiceMode !== "off" && voiceReply && !voiceRecording ? (
            <View style={[styles.voiceReplyCard, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
              <View style={styles.voiceReplyTop}>
                <View>
                  <Text role="bodyEm">Milo’s reply</Text>
                  <Text role="sub" ink={2}>{voiceMode === "auto" ? "Auto voice reply" : "Tap to listen"}</Text>
                </View>
                <View style={styles.voiceReplyActions}>
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={voicePlaying ? "Pause Milo voice reply" : "Play Milo voice reply"}
                    onPress={toggleVoicePlayback}
                    style={[styles.voicePlayButton, { backgroundColor: colors.accent }]}
                  >
                    <Text role="bodyEm" style={styles.voiceActionPrimary}>{voicePlaying ? "Ⅱ" : "▶"}</Text>
                  </Touchable>
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss Milo voice reply"
                    onPress={dismissVoiceReply}
                    style={[styles.voiceDismissButton, { borderColor: colors.surfaceEdge }]}
                  >
                    <CloseIcon color={colors.ink2} />
                  </Touchable>
                </View>
              </View>
              <View
                style={styles.voiceTrackTouch}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={(event) => {
                  // `locationX` is relative to this track; layout width is cached below.
                  if (voiceTrackWidthRef.current > 0) {
                    seekVoiceReply(event.nativeEvent.locationX / voiceTrackWidthRef.current);
                  }
                }}
                onResponderMove={(event) => {
                  if (voiceTrackWidthRef.current > 0) seekVoiceReply(event.nativeEvent.locationX / voiceTrackWidthRef.current);
                }}
                onLayout={(event) => { voiceTrackWidthRef.current = event.nativeEvent.layout.width; }}
              >
                <View pointerEvents="none" style={[styles.voiceTrackBase, { backgroundColor: colors.surfaceEdge }]} />
                <View
                  pointerEvents="none"
                  style={[
                    styles.voiceTrackFill,
                    {
                      backgroundColor: colors.accent,
                      width: `${voiceProgress.duration > 0 ? Math.max(0, Math.min(100, (voiceProgress.current / voiceProgress.duration) * 100)) : 0}%`,
                    },
                  ]}
                />
                <View
                  pointerEvents="none"
                  style={[
                    styles.voiceScrubber,
                    {
                      backgroundColor: colors.accent,
                      left: `${voiceProgress.duration > 0 ? Math.max(0, Math.min(100, (voiceProgress.current / voiceProgress.duration) * 100)) : 0}%`,
                    },
                  ]}
                />
              </View>
              <Text role="micro" ink={2}>{Math.floor(voiceProgress.current / 60)}:{Math.floor(voiceProgress.current % 60).toString().padStart(2, "0")}{voiceProgress.duration > 0 ? ` / ${Math.floor(voiceProgress.duration / 60)}:${Math.floor(voiceProgress.duration % 60).toString().padStart(2, "0")}` : ""}</Text>
            </View>
          ) : null}
          {voiceError ? <Text role="sub" tone="danger">{voiceError}</Text> : null}
          <View
            style={[
              styles.composer,
              { backgroundColor: colors.surface, borderColor: colors.surfaceEdge },
              snapshot.approvals.length > 0 && styles.hidden,
            ]}
          >
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Attach images"
              onPress={() => void attach()}
              disabled={snapshot.hydrating || attachments.length >= 4}
              style={styles.attachButton}
            >
              <Text role="title" ink={attachments.length >= 4 ? 3 : 2}>
                ＋
              </Text>
            </Touchable>
            <TextInput
              value={draft}
              onChangeText={editDraft}
              placeholder={running ? "Add a follow-up…" : `Message ${agentName}…`}
              placeholderTextColor={colors.ink3}
              // Past the growth cap the field scrolls instead of freezing the
              // caret out of view — long pastes stay navigable.
              style={[styles.input, { color: colors.ink }]}
              multiline
              scrollEnabled
              editable={!snapshot.hydrating}
              onKeyPress={onComposerKeyPress}
            />
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Record voice message"
              disabled={snapshot.hydrating || transcribingVoice}
              onPress={() => void startVoiceRecording()}
              style={[styles.micButton, { backgroundColor: voiceRecording ? colors.accent : colors.bubble, borderColor: voiceRecording ? colors.accent : colors.surfaceEdge }]}
            >
              <MicrophoneIcon color={voiceRecording ? "#FFFFFF" : colors.ink2} />
            </Touchable>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={running ? "Stop" : "Send"}
              disabled={aborting || (!running && !canSend)}
              onPress={onPrimaryAction}
              style={styles.composerSendTouch}
            >
              <Animated.View
                style={[
                  styles.send,
                  { backgroundColor: running || aborting ? colors.danger : colors.accent, opacity: !running && !canSend ? 0.4 : 1 },
                ]}
              >
                {running || aborting ? (
                  <View style={styles.stopGlyph} />
                ) : (
                  <SendIcon />
                )}
              </Animated.View>
            </Touchable>
          </View>
          <View style={styles.chipRow}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`Model ${model ?? "default"}${effort ? `, effort ${effort}` : ""}. Change model`}
              onPress={openModelSheet}
              style={styles.modelChip}
            >
              <Text role="sub" ink={2} mono numberOfLines={1}>
                {modelSaving ? "Saving…" : model ? model.split("/").pop() : "model"}
                {!modelSaving && effort ? ` · ${effort}` : ""}
              </Text>
            </Touchable>
            {snapshot.device ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Permission mode: ${snapshot.device.permissionMode}. Change controls`}
                onPress={() => {
                  dismissChatKeyboard();
                  controlsSheetRef.current?.present();
                }}
                style={styles.modelChip}
              >
                <Text role="sub" ink={2}>
                  {snapshot.device.permissionMode === "acceptEdits"
                    ? "Accept edits"
                    : snapshot.device.permissionMode === "unrestricted"
                      ? "Unrestricted"
                      : "Standard"}
                </Text>
              </Touchable>
            ) : null}
            <View style={styles.spacer} />
            {running && canSend ? (
              <Touchable accessibilityRole="button" accessibilityLabel="Queue follow-up" onPress={sendWhileRunning} style={styles.queueSend}>
                <Text role="sub" tone="accent">
                  Queue
                </Text>
              </Touchable>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
      <QueueSheet
        ref={queueSheetRef}
        queue={snapshot.queue}
        onRemove={(id) => void sessionRef.current?.removeQueueItem(id)}
        onEditResend={(item) => {
          void sessionRef.current?.removeQueueItem(item.id);
          // Never destroy work in progress: append behind whatever is typed.
          editDraft(draftRef.current.trim() ? `${draftRef.current.trimEnd()}\n${item.text}` : item.text);
          queueSheetRef.current?.dismiss();
        }}
      />
      <Sheet ref={controlsSheetRef} title="Permission mode">
        {(
          [
            { mode: "strict" as PermissionMode, label: "Strict", detail: "Every tool asks, even reads" },
            { mode: "standard" as PermissionMode, label: "Standard", detail: "Asks before risky tools" },
            { mode: "acceptEdits" as PermissionMode, label: "Accept edits", detail: "File edits are auto-approved" },
            { mode: "unrestricted" as PermissionMode, label: "Unrestricted", detail: "Everything auto-approved" },
          ]
        ).map(({ mode, label, detail }) => {
          const selected = snapshot.device?.permissionMode === mode;
          return (
            <Touchable
              key={mode}
              accessibilityRole="button"
              accessibilityLabel={`${label}. ${detail}${selected ? ". Selected" : ""}`}
              onPress={() => {
                if (activeProfile) void AsyncStorage.setItem(permissionStorageKey(activeProfile.id), mode);
                void sessionRef.current?.setPermissionMode(mode);
                controlsSheetRef.current?.dismiss();
              }}
              style={styles.permissionRow}
            >
              <View style={styles.permissionRowInner}>
                <View style={styles.permissionText}>
                  <Text role="body" tone={mode === "unrestricted" ? "danger" : undefined}>
                    {label}
                  </Text>
                  <Text role="sub" ink={3}>
                    {detail}
                  </Text>
                </View>
                {selected ? (
                  <Text role="bodyEm" tone="accent">
                    ✓
                  </Text>
                ) : null}
              </View>
            </Touchable>
          );
        })}
        {snapshot.device?.workingDirectory ? (
          <Text role="sub" ink={3} mono numberOfLines={1}>
            cwd: {snapshot.device.workingDirectory}
          </Text>
        ) : null}
        {snapshot.device?.memoryDirectory ? (
          <Text role="sub" ink={3} mono numberOfLines={1}>
            memory: {snapshot.device.memoryDirectory}
          </Text>
        ) : null}
      </Sheet>
      <Sheet ref={conversationStatusSheetRef} title="Conversation status" scroll>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Rename conversation"
          onPress={openRenameConversation}
          style={[styles.diagnosticsRename, { borderColor: colors.surfaceEdge }]}
        >
          <Text role="bodyEm">Rename conversation</Text>
        </Touchable>
        {diagnosticsLoading && !conversationDiagnostics ? (
          <View style={styles.diagnosticsLoading}>
            <ActivityIndicator size="small" color={colors.ink3} />
            <Text role="sub" ink={3}>Reading Milo's current context…</Text>
          </View>
        ) : null}
        {conversationDiagnostics ? (() => {
          const used = conversationDiagnostics.contextTokens;
          const limit = conversationDiagnostics.contextWindow;
          const ratio = used != null && limit != null && limit > 0 ? Math.min(1, used / limit) : null;
          const pct = ratio == null ? null : Math.round(ratio * 100);
          const lastCompact = conversationDiagnostics.lastCompaction;
          return (
            <>
              <View style={styles.diagnosticsHero}>
                <View style={styles.diagnosticsHeroTop}>
                  <Text role="bodyEm">Context window</Text>
                  <Text role="bodyEm" mono>{pct == null ? "—" : `${pct}%`}</Text>
                </View>
                <Text role="sub" ink={2} mono>
                  {formatTokens(used)} / {formatTokens(limit)} tokens
                </Text>
                <View style={[styles.contextTrack, { backgroundColor: colors.surfaceEdge }]}>
                  <View
                    style={[
                      styles.contextFill,
                      { backgroundColor: colors.accent, width: ratio == null ? "0%" : `${Math.max(2, ratio * 100)}%` },
                    ]}
                  />
                </View>
                <Text role="sub" ink={3}>
                  {conversationDiagnostics.pendingCompaction ? "Compaction pending" : "Latest completed model step"}
                </Text>
              </View>

              <View style={styles.diagnosticsGrid}>
                <View style={styles.diagnosticCell}>
                  <Text role="sub" ink={3}>Model</Text>
                  <Text role="bodyEm" numberOfLines={2}>{conversationDiagnostics.model?.split("/").pop() ?? "—"}</Text>
                </View>
                <View style={styles.diagnosticCell}>
                  <Text role="sub" ink={3}>Context change</Text>
                  <Text role="bodyEm" mono>
                    {conversationDiagnostics.contextHistory.length >= 2
                      ? (() => {
                          const history = conversationDiagnostics.contextHistory;
                          const delta = history[history.length - 1]!.tokens - history[history.length - 2]!.tokens;
                          return `${delta >= 0 ? "+" : ""}${formatTokens(delta)} tokens`;
                        })()
                      : "—"}
                  </Text>
                </View>
                <View style={styles.diagnosticCell}>
                  <Text role="sub" ink={3}>Core memory share</Text>
                  <Text role="bodyEm" mono>
                    {conversationDiagnostics.contextWindow && conversationDiagnostics.contextWindow > 0
                      ? `≈ ${Math.round((conversationDiagnostics.coreMemoryEstimatedTokens / conversationDiagnostics.contextWindow) * 100)}%`
                      : "—"}
                  </Text>
                </View>
                <View style={styles.diagnosticCell}>
                  <Text role="sub" ink={3}>Recent samples</Text>
                  <Text role="bodyEm" mono>{conversationDiagnostics.contextHistory.length}</Text>
                </View>
              </View>

              <View style={[styles.diagnosticsSection, { borderColor: colors.surfaceEdge }]}>
                <Text role="bodyEm">Core memory</Text>
                <Text role="sub" ink={2}>
                  ≈ {formatTokens(conversationDiagnostics.coreMemoryEstimatedTokens)} tokens across {conversationDiagnostics.coreMemoryBlocks} visible blocks
                </Text>
                <Text role="sub" ink={3}>
                  Estimated from {formatTokens(conversationDiagnostics.coreMemoryCharacters)} characters; exact tokenizer cost varies by model.
                </Text>
              </View>

              <View style={[styles.diagnosticsSection, { borderColor: colors.surfaceEdge }]}>
                <Text role="bodyEm">Last compaction</Text>
                {lastCompact ? (
                  <>
                    <Text role="sub" ink={2} mono>
                      {formatTokens(lastCompact.contextTokensBefore)} → {formatTokens(lastCompact.contextTokensAfter)} tokens
                    </Text>
                    <Text role="sub" ink={3}>
                      {lastCompact.messagesBefore != null && lastCompact.messagesAfter != null
                        ? `${lastCompact.messagesBefore} → ${lastCompact.messagesAfter} in-context messages`
                        : "Compaction recorded"}
                      {lastCompact.trigger ? ` · ${lastCompact.trigger.replaceAll("_", " ")}` : ""}
                    </Text>
                  </>
                ) : (
                  <Text role="sub" ink={3}>No compaction statistics reported in recent history.</Text>
                )}
              </View>
            </>
          );
        })() : null}

        {diagnosticsError ? <Text role="sub" tone="danger">{diagnosticsError}</Text> : null}
        <View style={styles.diagnosticsActions}>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Refresh conversation status"
            onPress={() => void refreshConversationDiagnostics()}
            style={[styles.diagnosticsSecondary, { borderColor: colors.surfaceEdge }]}
          >
            <Text role="bodyEm">Refresh</Text>
          </Touchable>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Compact conversation"
            disabled={compactingConversation || snapshot.run === "running" || snapshot.run === "awaiting_approval" || snapshot.run === "aborting"}
            onPress={requestConversationCompaction}
            style={[
              styles.diagnosticsPrimary,
              { backgroundColor: colors.accent, opacity: compactingConversation || snapshot.run === "running" || snapshot.run === "awaiting_approval" || snapshot.run === "aborting" ? 0.45 : 1 },
            ]}
          >
            {compactingConversation ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text role="bodyEm" style={styles.diagnosticsPrimaryText}>Compact</Text>}
          </Touchable>
        </View>
        {snapshot.run === "running" || snapshot.run === "awaiting_approval" || snapshot.run === "aborting" ? (
          <Text role="sub" ink={3}>Compaction is available when the current run finishes.</Text>
        ) : null}
      </Sheet>
      <Sheet ref={renameSheetRef} title="Rename conversation">
        <SheetTextInput
          value={renameDraft}
          onChangeText={setRenameDraft}
          placeholder="Conversation title"
          placeholderTextColor={colors.ink3}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submitConversationRename()}
          style={[styles.renameInput, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Save conversation title"
          onPress={() => void submitConversationRename()}
          disabled={renameDraft.trim().length === 0 || renamingConversation}
          style={[
            styles.renameSave,
            {
              backgroundColor: colors.accent,
              opacity: renameDraft.trim().length === 0 || renamingConversation ? 0.45 : 1,
            },
          ]}
        >
          {renamingConversation ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text role="bodyEm" style={styles.diagnosticsPrimaryText}>Save</Text>
          )}
        </Touchable>
      </Sheet>
      <SecretSheet
        ref={secretSheetRef}
        names={secretNames}
        loading={secretLoading}
        error={secretError}
        onRefresh={refreshAgentSecrets}
        onApply={applyAgentSecrets}
      />
      <ToolDetailSheet ref={toolSheetRef} tool={detailTool} />
      <ModelSheet
        ref={modelSheetRef}
        models={models}
        currentModel={model}
        currentEffort={effort}
        onSelect={(handle, nextEffort) => void selectModel(handle, nextEffort)}
        onSelectEffort={(nextEffort) => void selectEffort(nextEffort)}
        error={modelError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Inverted list: style paddingTop renders at the VISUAL bottom (above the
  // composer), paddingBottom at the visual top.
  transcript: { paddingHorizontal: space.gutter, paddingTop: space.xl, paddingBottom: space.md, gap: space.md },
  // FlatList does not counter-rotate ListEmptyComponent when `inverted` is set.
  invertedEmpty: { transform: [{ scaleY: -1 }] },
  latestWrap: { position: "absolute", left: 0, right: 0, bottom: space.md, alignItems: "center" },
  olderSpinner: { paddingVertical: space.md, alignItems: "center" },
  attachRow: { flexDirection: "row", gap: space.sm, paddingBottom: space.sm },
  attachChip: { width: 64, height: 64 },
  attachThumb: { width: 64, height: 64, borderRadius: radius.row },
  attachRemove: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButton: { paddingRight: space.sm, minHeight: 32, justifyContent: "center" },
  latest: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.chip,
    paddingHorizontal: space.md,
    minHeight: 32,
  },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.gutter,
    paddingTop: space.md,
    gap: space.sm,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  // ~7 lines before it scrolls: references cap growth near a third of the
  // screen so the transcript never disappears behind the composer.
  input: { flex: 1, minHeight: 38, fontSize: 16, lineHeight: 21, maxHeight: 168, paddingHorizontal: 0, paddingVertical: 8 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  voiceModePill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.chip, paddingHorizontal: space.md, paddingVertical: 7 },
  voiceModeContent: { flexDirection: "row", alignItems: "center", gap: 7 },
  micButton: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", marginLeft: space.sm },
  voiceRecorderPanel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sheet, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, alignItems: "center" },
  transcriptionTrack: { width: "100%", height: 8, borderRadius: 4, overflow: "hidden" },
  transcriptionFill: { height: "100%", borderRadius: 4 },
  waveform: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, width: "100%" },
  waveBar: { width: 3, borderRadius: 2 },
  voiceRecorderActions: { flexDirection: "row", gap: space.md, justifyContent: "center", paddingTop: 2 },
  voiceActionIcon: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  voiceAutoSendPill: { alignSelf: "center", minHeight: 32, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.chip, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.md },
  voiceActionPrimary: { color: "#FFFFFF" },
  voiceReplyCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, padding: space.md, gap: space.sm },
  voiceReplyTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  voiceReplyActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  voicePlayButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  voiceDismissButton: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  voiceTrackTouch: { height: 18, justifyContent: "center", position: "relative", overflow: "visible" },
  voiceTrackBase: { position: "absolute", left: 0, right: 0, top: 7, height: 4, borderRadius: 2 },
  voiceTrackFill: { height: 4, borderRadius: 2, zIndex: 1 },
  voiceScrubber: { position: "absolute", width: 12, height: 12, borderRadius: 6, top: 3, marginLeft: -6, zIndex: 2 },
  hidden: { display: "none" },
  spacer: { flex: 1 },
  queueSend: { paddingHorizontal: space.sm },
  modelChip: { maxWidth: 220, paddingVertical: 4 },
  diagnosticsLoading: { minHeight: 90, alignItems: "center", justifyContent: "center", gap: space.sm },
  diagnosticsHero: { gap: space.sm },
  diagnosticsHeroTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  contextTrack: { height: 7, borderRadius: 4, overflow: "hidden" },
  contextFill: { height: 7, borderRadius: 4 },
  diagnosticsGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  diagnosticCell: { width: "47%", minWidth: 120, gap: 2, paddingVertical: space.xs },
  diagnosticsSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, gap: 4 },
  diagnosticsRename: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, marginTop: space.xs },
  diagnosticsActions: { flexDirection: "row", gap: space.sm, paddingTop: space.xs },
  diagnosticsSecondary: { flex: 1, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md },
  diagnosticsPrimary: { flex: 1, minHeight: 44, borderRadius: radius.row, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md },
  diagnosticsPrimaryText: { color: "#FFFFFF" },
  renameInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, paddingHorizontal: space.md, paddingVertical: 11, fontSize: 16 },
  renameSave: { minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  permissionRow: { minHeight: 52 },
  permissionRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  permissionText: { flex: 1, gap: 1 },
  composerSendTouch: { width: 44, height: 44, marginLeft: space.sm, alignItems: "center", justifyContent: "center" },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  sendGlyph: { color: "#FFFFFF" },
  stopGlyph: { width: 12, height: 12, borderRadius: 2, backgroundColor: "#FFFFFF" },
});
