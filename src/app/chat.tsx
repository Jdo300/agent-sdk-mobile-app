/**
 * Chat — the product (docs/design-doc.md §4.4). A ChatSession bridges the
 * Agent SDK stream into the snapshot the transcript renders. The composer
 * stays enabled during a run (sends become queued follow-ups, server-
 * confirmed); the send button morphs into stop.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
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
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  updateConversationModel,
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
import { getSecret } from "../lib/profiles/profiles";
import {
  getVoiceMode,
  nextVoiceMode,
  setVoiceMode as persistVoiceMode,
  speechSource,
  transcribeVoice,
  voiceModeLabel,
  type VoiceMode,
} from "../lib/voice";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radius, space } from "../theme/tokens";

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

// Memoized so a streaming flush only re-renders the row whose item changed:
// upsertItem preserves untouched item identity, so reference equality holds.
const TranscriptRow = memo(function TranscriptRow({
  item,
  onUserRetry,
  onToolPress,
  onErrorRetry,
  onToggleGroup,
}: {
  item: TranscriptRowItem;
  onUserRetry?: (id: string) => void;
  onToolPress?: (id: string) => void;
  onErrorRetry?: () => void;
  onToggleGroup?: (id: string) => void;
}) {
  switch (item.kind) {
    case "toolGroup":
      return (
        <ToolGroupRow group={item} onToggle={() => onToggleGroup?.(item.id)} />
      );
    case "user":
      return <UserBubble item={item} onRetry={onUserRetry ? () => onUserRetry(item.id) : undefined} />;
    case "assistant":
      return <AssistantBlock item={item} />;
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
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [transcribingVoice, setTranscribingVoice] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceReply, setVoiceReply] = useState<{ id: string; text: string } | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState({ current: 0, duration: 0 });
  const voicePlayerRef = useRef<AudioPlayer | null>(null);
  const voicePlayerSubRef = useRef<{ remove(): void } | null>(null);
  const voiceTrackWidthRef = useRef(0);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);

  useEffect(() => {
    void getVoiceMode().then((mode) => {
      setVoiceModeState(mode);
      setVoiceModeLoaded(true);
    });
    return () => {
      voicePlayerSubRef.current?.remove();
      voicePlayerRef.current?.remove();
    };
  }, []);

  const cycleVoiceMode = useCallback(() => {
    const next = nextVoiceMode(voiceMode);
    setVoiceModeState(next);
    void persistVoiceMode(next);
    if (next === "off") {
      voicePlayerRef.current?.pause();
      setVoicePlaying(false);
    }
    haptic.tap();
  }, [voiceMode]);

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
    recorder.record();
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
      const uri = recorder.uri;
      if (!uri) throw new Error("The recording could not be saved.");
      const token = (await getSecret(activeProfile.id)) ?? "";
      if (!token) throw new Error("The Local Milo capability token is unavailable.");
      const text = await transcribeVoice(uri, token);
      setDraft(text);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Voice transcription failed.");
    } finally {
      setTranscribingVoice(false);
      await setAudioModeAsync({ allowsRecording: false });
    }
  }, [activeProfile, recorder, recorderState.isRecording]);

  const playVoiceText = useCallback(async (text: string) => {
    if (!activeProfile || !text.trim()) return;
    try {
      setVoiceError(null);
      // Playback should be reliable regardless of whether the microphone was
      // used first, and should remain audible with the iPhone silent switch on.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const token = (await getSecret(activeProfile.id)) ?? "";
      if (!token) throw new Error("The Local Milo capability token is unavailable.");
      voicePlayerSubRef.current?.remove();
      voicePlayerRef.current?.remove();
      const player = createAudioPlayer(speechSource(text, token), { updateInterval: 150 });
      voicePlayerRef.current = player;
      voicePlayerSubRef.current = player.addListener("playbackStatusUpdate", (status) => {
        if (status.duration > 0) {
          setVoiceProgress({ current: status.currentTime || 0, duration: status.duration });
        }
        if (status.didJustFinish) setVoicePlaying(false);
      });
      player.play();
      setVoicePlaying(true);
    } catch (error) {
      setVoicePlaying(false);
      setVoiceError(error instanceof Error ? error.message : "Voice playback failed.");
    }
  }, [activeProfile]);

  const toggleVoicePlayback = useCallback(() => {
    const player = voicePlayerRef.current;
    if (player) {
      if (player.playing) {
        player.pause();
        setVoicePlaying(false);
      } else {
        const duration = player.duration || voiceProgress.duration;
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
  }, [voiceReply, voiceProgress.duration, playVoiceText]);

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
    const player = voicePlayerRef.current;
    const duration = player?.duration || voiceProgress.duration;
    if (!player || !duration || !Number.isFinite(duration)) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    const nextTime = duration * clamped;
    setVoiceProgress({ current: nextTime, duration });
    void player.seekTo(nextTime);
  }, [voiceProgress.duration]);

  const dismissVoiceReply = useCallback(() => {
    voicePlayerSubRef.current?.remove();
    voicePlayerSubRef.current = null;
    voicePlayerRef.current?.remove();
    voicePlayerRef.current = null;
    setVoicePlaying(false);
    setVoiceProgress({ current: 0, duration: 0 });
    setVoiceReply(null);
  }, []);
  const attach = useCallback(async () => {
    haptic.tap();
    const picked = await pickImages();
    if (picked.length > 0) setAttachments((current) => [...current, ...picked].slice(0, 4));
  }, []);
  const nearBottomRef = useRef(true);
  // Inverted list: the newest content lives at offset 0.
  const pinToLatest = useCallback(() => {
    nearBottomRef.current = true;
    setNearBottom(true);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

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

  // Foreground resume: refetch authoritative state when the app returns, but
  // only after a real absence — a glance at a notification shouldn't cost a
  // full rehydrate and a banner flash.
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : Infinity;
        backgroundedAt.current = null;
        if (away > 30_000) void sessionRef.current?.reconnect();
        return;
      }
      backgroundedAt.current ??= Date.now();
    });
    return () => sub.remove();
  }, []);

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
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState<"allow" | "deny" | undefined>();

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
    Keyboard.dismiss();
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
    void (async () => {
      try {
        const secret = (await getSecret(activeProfile.id)) ?? "";
        const session = ChatSession.open({ profile: activeProfile, secret }, params.conversationId);
        if (cancelled) {
          session.close();
          return;
        }
        opened = session;
        sessionRef.current = session;
        // Scrolling belongs to the list's onContentSizeChange, not here: a
        // snapshot-time scroll races layout, since the hydration batch measures
        // after the scroll fires.
        session.subscribe(setSnapshot);
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
      opened?.close();
      sessionRef.current = null;
    };
  }, [activeProfile, params.conversationId]);

  // Load the current conversation model once hydration settles — on remote,
  // concurrent control-channel connections collide (single-slot app-server).
  useEffect(() => {
    if (!activeProfile || !params.conversationId || snapshot.hydrating) return;
    // Remote reads go through the session's own connection (the app-server
    // accepts one control client); wait briefly for the session ref, which is
    // set by the sibling effect. Cloud reads are plain REST.
    const timer = setTimeout(async () => {
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
        setModel(current.model);
        setEffort(current.reasoningEffort);
        if (current.title) setServerTitle(current.title);
      } catch {
        // Chip falls back to "model" affordance; sheet still works.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeProfile, params.conversationId, snapshot.hydrating]);

  const openModelSheet = useCallback(async () => {
    if (!activeProfile) return;
    setModelError(null);
    modelSheetRef.current?.present();
    if (models.length === 0) {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      try {
        setModels(await listModels({ profile: activeProfile, secret }));
      } catch {
        setModelError("Couldn't load models.");
      }
    }
  }, [activeProfile, models.length]);

  const selectModel = useCallback(
    async (handle: string, nextEffort?: ReasoningEffort) => {
      if (!activeProfile || !params.conversationId) return;
      modelSheetRef.current?.dismiss();
      const previous = { model, effort };
      setModel(handle);
      if (nextEffort) setEffort(nextEffort);
      setModelSaving(true);
      try {
        if (activeProfile.type === "remote" && sessionRef.current) {
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

  const running = snapshot.run === "running" || snapshot.run === "awaiting_approval";
  const aborting = snapshot.run === "aborting";
  const previousRunRef = useRef(snapshot.run);
  const voiceRunPendingRef = useRef(false);
  const voiceBaselineAssistantIdRef = useRef<string | null>(null);
  useEffect(() => {
    const latestCompletedAssistant = [...snapshot.transcript].reverse().find(
      (item) => item.kind === "assistant" && !item.streaming && !item.interrupted && item.text.trim().length > 0,
    );
    const previous = previousRunRef.current;
    previousRunRef.current = snapshot.run;

    // Mark the beginning of a new run and remember the last completed reply that
    // existed before it. The app-server can report idle a moment before the final
    // assistant transcript row is marked complete, so do not require both events
    // to land in the same render.
    if (previous === "idle" && snapshot.run !== "idle") {
      voiceRunPendingRef.current = true;
      voiceBaselineAssistantIdRef.current =
        latestCompletedAssistant?.kind === "assistant" ? latestCompletedAssistant.id : null;
      return;
    }

    if (!voiceRunPendingRef.current || snapshot.run !== "idle") return;
    if (!voiceModeLoaded) return;
    if (!latestCompletedAssistant || latestCompletedAssistant.kind !== "assistant") return;
    if (latestCompletedAssistant.id === voiceBaselineAssistantIdRef.current) return;

    // We now have the completed assistant reply for the run that just ended.
    // Clear the pending flag only after the new row actually arrives so a small
    // protocol/transcript timing skew cannot make auto voice silently miss it.
    voiceRunPendingRef.current = false;
    setVoiceReply({ id: latestCompletedAssistant.id, text: latestCompletedAssistant.text });
    setVoiceProgress({ current: 0, duration: 0 });
    voicePlayerSubRef.current?.remove();
    voicePlayerRef.current?.remove();
    voicePlayerRef.current = null;
    setVoicePlaying(false);
    if (voiceMode === "auto") void playVoiceText(latestCompletedAssistant.text);
  }, [snapshot.run, snapshot.transcript, voiceMode, voiceModeLoaded, playVoiceText]);

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

  // Send ↔ stop morph.
  const morph = useSharedValue(0);
  useEffect(() => {
    morph.set(withSpring(running || aborting ? 1 : 0, motion.move));
  }, [running, aborting, morph]);
  const morphStyle = useAnimatedStyle(() => ({
    borderRadius: 17 - morph.get() * 9,
  }));

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
    Keyboard.dismiss();
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
    Keyboard.dismiss();
    haptic.queue();
    const images = attachments;
    setAttachments([]);
    clearDraft();
    pinToLatest();
    await session.send(text, images);
  }, [draft, attachments, pinToLatest, clearDraft, interceptSecretCommand]);

  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const agentName = params.agentName ?? "Agent";
  const title = serverTitle ?? params.title ?? "Conversation";

  // Inverted-list data (references do chat this way — e.g. paseo's native
  // strategy): the visual bottom is offset 0, so new content pins natively
  // and keyboard/layout changes can't break "near bottom" tracking.
  const listData = useMemo(
    () => groupToolRuns(snapshot.transcript, expandedGroups).reverse(),
    [snapshot.transcript, expandedGroups],
  );
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

  // Stable renderItem keeps TranscriptRow's memo effective across flushes.
  const renderItem = useCallback(
    ({ item }: { item: TranscriptRowItem }) => (
      <TranscriptRow
        item={item}
        onUserRetry={onUserRetry}
        onToolPress={onToolPress}
        onErrorRetry={onErrorRetry}
        onToggleGroup={onToggleGroup}
      />
    ),
    [onUserRetry, onToolPress, onErrorRetry, onToggleGroup],
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
              Platform.OS === "ios" ? { minIndexForVisible: 0, autoscrollToTopThreshold: 40 } : undefined
            }
            // maintainVisibleContentPosition keeps a scrolled-up reader in place
            // but does not guarantee the live edge stays pinned once a hydration
            // batch measures, so re-pin explicitly for a reader who is following.
            onContentSizeChange={() => {
              if (nearBottomRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
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
            onScrollBeginDrag={() => Keyboard.dismiss()}
            onScroll={(e) => {
              const offset = e.nativeEvent.contentOffset.y;
              nearBottomRef.current = offset < 80;
              setNearBottom(offset < 80);
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
              Keyboard.dismiss();
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
              <Text role="bodyEm" tone="accent">{transcribingVoice ? "Transcribing…" : "Listening…"}</Text>
              <Text role="title">{Math.floor(recorderState.durationMillis / 60000).toString().padStart(2, "0")}:{Math.floor((recorderState.durationMillis % 60000) / 1000).toString().padStart(2, "0")}</Text>
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
                  disabled={transcribingVoice}
                  onPress={() => void finishVoiceRecording()}
                  style={[styles.voiceActionIcon, { backgroundColor: colors.accent, borderColor: colors.accent, opacity: transcribingVoice ? 0.5 : 1 }]}
                >
                  <CheckIcon color="#FFFFFF" />
                </Touchable>
              </View>
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
                  morphStyle,
                  { backgroundColor: running || aborting ? colors.danger : colors.accent, opacity: !running && !canSend ? 0.4 : 1 },
                ]}
              >
                {running || aborting ? (
                  <View style={styles.stopGlyph} />
                ) : (
                  <Text role="bodyEm" style={styles.sendGlyph}>↑</Text>
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
                  Keyboard.dismiss();
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
  waveform: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, width: "100%" },
  waveBar: { width: 3, borderRadius: 2 },
  voiceRecorderActions: { flexDirection: "row", gap: space.md, justifyContent: "center", paddingTop: 2 },
  voiceActionIcon: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
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
