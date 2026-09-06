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
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
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
import Animated, { FadeIn, FadeOut, FadeInDown, FadeOutDown } from "react-native-reanimated";
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
import { Text, TextScaleProvider } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { haptic } from "../lib/haptics";
import { ChatSession } from "../lib/letta/ChatSession";
import { isSecretSlashCommand } from "../lib/letta/secretCommands";
import {
  getConversationModel,
  deleteConversation,
  createConversation,
  listConversations,
  isAuthError,
  listModels,
  renameConversation,
  setConversationArchived,
  updateConversationModel,
  type ConversationDiagnostics,
  type ConversationSummary,
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
import { pickImages, pickAudio, type Attachment, type AudioAttachment } from "../lib/letta/attachments";
import { getSecret } from "../lib/profiles/profiles";
import {
  getVoiceMode,
  nextVoiceMode,
  setVoiceMode as persistVoiceMode,
  speechSource,
  officeBrowserSpeechSource,
  transcribeVoice,
  KOKORO_PLAYBACK_RATE,
  prepareSpeechText,
  voiceModeLabel,
  type VoiceMode,
  type TranscriptionProgress,
} from "../lib/voice";
import { registerConversationPush } from "../lib/pushNotifications";
import { newVoiceTraceId, replayPersistedVoiceTrace, voiceTrace } from "../lib/voiceDiagnostics";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radius, space } from "../theme/tokens";

const RUNTIME_PERMISSION_KEY_PREFIX = "milo.runtime.permission.v1:";
const RUNTIME_EFFORT_KEY_PREFIX = "milo.runtime.reasoning.v1:";
const VOICE_AUTO_SEND_KEY = "milo.voice.autoSend.v1";
const DESKTOP_SIDEBAR_KEY = "bloop.desktop.sidebar.open.v1";
const DESKTOP_TEXT_SCALE_KEY = "bloop.desktop.textScale.v1";
const DESKTOP_TEXT_SCALE_MIN = 0.8;
const DESKTOP_TEXT_SCALE_MAX = 1.5;
const DESKTOP_TEXT_SCALE_STEP = 0.1;

function storedDesktopBoolean(key: string, fallback: boolean): boolean {
  if (Platform.OS !== "web") return fallback;
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value == null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function storedDesktopScale(): number {
  if (Platform.OS !== "web") return 1;
  try {
    const value = Number(globalThis.localStorage?.getItem(DESKTOP_TEXT_SCALE_KEY));
    return Number.isFinite(value) && value >= DESKTOP_TEXT_SCALE_MIN && value <= DESKTOP_TEXT_SCALE_MAX ? value : 1;
  } catch {
    return 1;
  }
}
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

function PhotoIcon({ color, size = 21 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V8a1.5 1.5 0 0 1 1.5-1.5Z" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m6 17 3.8-4 2.8 2.8 1.7-1.8 3.7 3.9M16.7 10.4h.01" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
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
  onUserRemove,
  onUserCancel,
  onToolPress,
  onErrorRetry,
  onToggleGroup,
  onAssistantReplay,
}: {
  item: TranscriptRowItem;
  onUserRetry?: (id: string) => void;
  onUserRemove?: (id: string) => void;
  onUserCancel?: (id: string) => void;
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
      return (
        <UserBubble
          item={item}
          onRetry={onUserRetry ? () => onUserRetry(item.id) : undefined}
          onRemove={onUserRemove ? () => onUserRemove(item.id) : undefined}
          onCancel={onUserCancel ? () => onUserCancel(item.id) : undefined}
        />
      );
    case "assistant":
      return <AssistantBlock item={item} onVoiceReplay={onAssistantReplay && !item.streaming && !item.interrupted ? () => onAssistantReplay(item.id, item.text) : undefined} />;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "tool":
      return <ToolCard item={item} onPress={onToolPress ? () => onToolPress(item.id) : undefined} />;
    case "error":
      return <ErrorRow item={item} onRetry={onErrorRetry} />;
  }
}, (previous, next) => {
  if (
    previous.onUserRetry !== next.onUserRetry ||
    previous.onUserRemove !== next.onUserRemove ||
    previous.onUserCancel !== next.onUserCancel ||
    previous.onToolPress !== next.onToolPress ||
    previous.onErrorRetry !== next.onErrorRetry ||
    previous.onToggleGroup !== next.onToggleGroup ||
    previous.onAssistantReplay !== next.onAssistantReplay
  ) return false;
  if (previous.item === next.item) return true;
  const previousItem = previous.item;
  const nextItem = next.item;
  if (previousItem.kind !== "toolGroup" || nextItem.kind !== "toolGroup") return false;
  if (
    previousItem.id !== nextItem.id ||
    previousItem.failed !== nextItem.failed ||
    previousItem.expanded !== nextItem.expanded ||
    previousItem.tools.length !== nextItem.tools.length
  ) return false;
  return previousItem.tools.every((tool, index) => tool === nextItem.tools[index]);
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


function DesktopConversationSidebar({
  visible,
  onClose,
  agentId,
  agentName,
  currentConversationId,
}: {
  visible: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  currentConversationId: string;
}) {
  const { colors } = useTheme();
  const { activeProfile } = useProfiles();
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ conversation: ConversationSummary; x: number; y: number } | null>(null);

  const renameFromMenu = useCallback(async (conversation: ConversationSummary) => {
    if (!activeProfile || Platform.OS !== "web") return;
    const next = globalThis.prompt?.("Rename conversation", conversation.title)?.trim();
    if (!next || next === conversation.title) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await renameConversation({ profile: activeProfile, secret }, conversation.id, next);
      setRows((current) => (current ?? []).map((row) => row.id === conversation.id ? { ...row, title: next } : row));
    } catch (e) {
      globalThis.alert?.(e instanceof Error ? e.message : "Couldn't rename conversation.");
    }
  }, [activeProfile]);

  const setArchivedFromMenu = useCallback(async (conversation: ConversationSummary, archived: boolean) => {
    if (!activeProfile || Platform.OS !== "web") return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await setConversationArchived({ profile: activeProfile, secret }, conversation.id, archived);
      setRows((current) => (current ?? []).filter((row) => row.id !== conversation.id));
      if (archived && conversation.id === currentConversationId) {
        const id = await createConversation({ profile: activeProfile, secret }, agentId);
        router.replace({ pathname: "/chat", params: { conversationId: id, agentId, agentName, title: "New conversation" } });
      }
    } catch (e) {
      globalThis.alert?.(e instanceof Error ? e.message : archived ? "Couldn't archive conversation." : "Couldn't unarchive conversation.");
    }
  }, [activeProfile, currentConversationId, agentId, agentName]);

  const deleteFromMenu = useCallback(async (conversation: ConversationSummary) => {
    if (!activeProfile || Platform.OS !== "web") return;
    if (!globalThis.confirm?.(`Delete “${conversation.title}”?`)) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await deleteConversation({ profile: activeProfile, secret }, conversation.id);
      setRows((current) => (current ?? []).filter((row) => row.id !== conversation.id));
    } catch (e) {
      globalThis.alert?.(e instanceof Error ? e.message : "Couldn't delete conversation.");
    }
  }, [activeProfile]);

  const createNewConversation = useCallback(async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const id = await createConversation({ profile: activeProfile, secret }, agentId);
      setContextMenu(null);
      router.replace({ pathname: "/chat", params: { conversationId: id, agentId, agentName, title: "New conversation" } });
    } catch (e) {
      if (Platform.OS === "web") globalThis.alert?.(e instanceof Error ? e.message : "Couldn't start a conversation.");
    }
  }, [activeProfile, agentId, agentName]);

  useEffect(() => {
    if (!contextMenu || Platform.OS !== "web") return;
    const close = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-conversation-context="true"]')) return;
      setContextMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("keydown", escape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!visible || !activeProfile || !agentId) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const secret = (await getSecret(activeProfile.id)) ?? "";
        const next = await listConversations({ profile: activeProfile, secret }, agentId, { limit: 50, archiveStatus: showArchived ? "archived" : "unarchived" });
        if (!cancelled) setRows(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load conversations.");
      }
    })();
    return () => { cancelled = true; };
  }, [visible, activeProfile, agentId, currentConversationId, showArchived]);

  if (!visible) return null;
  return (
    <View style={[styles.desktopSidebar, { backgroundColor: colors.bg, borderColor: colors.surfaceEdge }]}>
      <View style={[styles.desktopSidebarHeader, { borderColor: colors.surfaceEdge }]}>
        <View style={styles.desktopSidebarTitle}>
          <Text role="bodyEm">{showArchived ? "Archived" : "Conversations"}</Text>
          <Touchable accessibilityRole="button" accessibilityLabel={showArchived ? "Show active conversations" : "Show archived conversations"} onPress={() => { setContextMenu(null); setRows(null); setShowArchived((value) => !value); }} scaleOnPress={false}>
            <Text role="sub" tone="accent">{showArchived ? "Back to conversations" : "View archived"}</Text>
          </Touchable>
          <Text role="sub" ink={3}>{agentName}</Text>
        </View>
        <View style={styles.desktopSidebarActions}>
          <Touchable accessibilityRole="button" accessibilityLabel="New conversation" onPress={() => void createNewConversation()} style={styles.desktopSidebarClose}>
            <Text role="title" tone="accent">＋</Text>
          </Touchable>
          <Touchable accessibilityRole="button" accessibilityLabel="Hide conversations" onPress={onClose} style={styles.desktopSidebarClose}>
            <Text role="title" ink={2}>×</Text>
          </Touchable>
        </View>
      </View>
      {error ? <Text role="sub" tone="danger" style={styles.desktopSidebarMessage}>{error}</Text> : null}
      {rows === null && !error ? (
        <View style={styles.desktopSidebarLoading}><ActivityIndicator size="small" color={colors.ink3} /></View>
      ) : (
        <FlatList
          data={rows ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.desktopSidebarList}
          renderItem={({ item }) => {
            const selected = item.id === currentConversationId;
            return (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.title}`}
                onPress={() => {
                  setContextMenu(null);
                  if (!selected) router.replace({ pathname: "/chat", params: { conversationId: item.id, agentId, agentName, title: item.title } });
                }}
                {...({
                  onContextMenu: (event: any) => {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    event.nativeEvent?.stopPropagation?.();
                    const native = event.nativeEvent ?? event;
                    setContextMenu({ conversation: item, x: native.clientX ?? native.pageX ?? 16, y: native.clientY ?? native.pageY ?? 16 });
                  },
                } as any)}
                scaleOnPress={false}
                style={[styles.desktopSidebarRow, selected && { backgroundColor: colors.surface }]}
              >
                <Text role={selected ? "bodyEm" : "body"} numberOfLines={2}>{item.title}</Text>
              </Touchable>
            );
          }}
        />
      )}
      {contextMenu ? (
        <>
          <View
            {...({ dataSet: { conversationContext: "true" } } as any)}
            onLayout={(event) => {
              if (Platform.OS !== "web") return;
              const { width, height } = event.nativeEvent.layout;
              const gutter = 8;
              const viewportWidth = globalThis.innerWidth ?? width + gutter * 2;
              const viewportHeight = globalThis.innerHeight ?? height + gutter * 2;
              const nextX = Math.max(gutter, Math.min(contextMenu.x, viewportWidth - width - gutter));
              const nextY = Math.max(gutter, Math.min(contextMenu.y, viewportHeight - height - gutter));
              if (Math.abs(nextX - contextMenu.x) > 0.5 || Math.abs(nextY - contextMenu.y) > 0.5) {
                setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
              }
            }}
            style={[styles.desktopContextMenu, { left: contextMenu.x, top: contextMenu.y, backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
          >
            <Touchable accessibilityRole="button" accessibilityLabel="Rename conversation" onPress={() => { const conversation = contextMenu.conversation; setContextMenu(null); void renameFromMenu(conversation); }} scaleOnPress={false} style={styles.desktopContextItem}>
              <Text role="body">Rename</Text>
            </Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel={showArchived ? "Unarchive conversation" : "Archive conversation"} onPress={() => { const conversation = contextMenu.conversation; setContextMenu(null); void setArchivedFromMenu(conversation, !showArchived); }} scaleOnPress={false} style={styles.desktopContextItem}>
              <Text role="body">{showArchived ? "Unarchive" : "Archive"}</Text>
            </Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel="Delete conversation" onPress={() => { const conversation = contextMenu.conversation; setContextMenu(null); void deleteFromMenu(conversation); }} scaleOnPress={false} style={styles.desktopContextItem}>
              <Text role="body" tone="danger">Delete</Text>
            </Touchable>
          </View>
        </>
      ) : null}
    </View>
  );
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ conversationId: string; agentId: string; agentName?: string; title?: string; autosend?: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && windowWidth >= 1000;
  const [desktopDrawerOpen, setDesktopDrawerOpen] = useState(() => storedDesktopBoolean(DESKTOP_SIDEBAR_KEY, false));
  const [desktopTextScale, setDesktopTextScale] = useState(() => storedDesktopScale());
  const [desktopComposerHeight, setDesktopComposerHeight] = useState(128);
  const { activeProfile } = useProfiles();

  useEffect(() => {
    if (!isDesktopWeb) return;
    try { globalThis.localStorage?.setItem(DESKTOP_SIDEBAR_KEY, String(desktopDrawerOpen)); } catch { /* storage unavailable */ }
  }, [isDesktopWeb, desktopDrawerOpen]);

  useEffect(() => {
    if (!isDesktopWeb) return;
    try { globalThis.localStorage?.setItem(DESKTOP_TEXT_SCALE_KEY, desktopTextScale.toFixed(2)); } catch { /* storage unavailable */ }
  }, [isDesktopWeb, desktopTextScale]);

  const adjustDesktopTextScale = useCallback((delta: number) => {
    setDesktopTextScale((current) => {
      const next = Math.round((current + delta) * 10) / 10;
      return Math.max(DESKTOP_TEXT_SCALE_MIN, Math.min(DESKTOP_TEXT_SCALE_MAX, next));
    });
  }, []);

  const sessionRef = useRef<ChatSession | null>(null);
  const listRef = useRef<FlatList<TranscriptRowItem>>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({ ...emptyChat, hydrating: true });
  const [draft, setDraft] = useState("");
  const [desktopInputContentHeight, setDesktopInputContentHeight] = useState(21);
  // The nav param is only the title as it was when this screen was opened; a
  // rename (here or elsewhere) makes the server's value the truth.
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  // Collapsed tool runs the reader has opened (see lib/letta/grouping).
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // The + attachment menu (Photo / Audio) and the audio transcription flow.
  const [audioQueue, setAudioQueue] = useState<AudioAttachment[]>([]);
  const [transcribingAudio, setTranscribingAudio] = useState(false);
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
  const [browserVoiceLevel, setBrowserVoiceLevel] = useState(0);
  const browserMeterRef = useRef<{ stream?: MediaStream; context?: AudioContext; frame?: number } | null>(null);
  const finishingVoiceRef = useRef(false);
  const voiceTraceIdRef = useRef<string | null>(null);
  const voicePlayerRef = useRef<AudioPlayer | null>(null);
  const voicePlayerSubRef = useRef<{ remove(): void } | null>(null);
  const voicePlayRequestRef = useRef(0);
  const voiceAutoQueueRef = useRef<string[]>([]);
  const voiceInputActiveRef = useRef(false);
  const voicePausedForInputRef = useRef(false);
  const playVoiceTextRef = useRef<((text: string) => Promise<void>) | null>(null);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const voiceModeLoadedRef = useRef(voiceModeLoaded);
  const pendingVoiceCompletionsRef = useRef<Array<{ id: string; text: string }>>([]);
  const voiceCompletionHandlerRef = useRef<(completion: { id: string; text: string }) => void>(() => {});
  const voiceTrackWidthRef = useRef(0);
  const voiceDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);

  useEffect(() => {
    void replayPersistedVoiceTrace();
    let expected = Date.now() + 1000;
    const stallTimer = setInterval(() => {
      const now = Date.now();
      const delayMs = now - expected;
      expected = now + 1000;
      const traceId = voiceTraceIdRef.current;
      if (traceId && delayMs > 1500) voiceTrace(traceId, "js_event_loop_stall", { delayMs });
    }, 1000);
    const appStateSub = AppState.addEventListener("change", (state) => {
      const traceId = voiceTraceIdRef.current;
      if (traceId) voiceTrace(traceId, "app_state", { state });
    });
    return () => {
      clearInterval(stallTimer);
      appStateSub.remove();
    };
  }, []);

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
      voiceAutoQueueRef.current = [];
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

  const stopBrowserVoiceMeter = useCallback(() => {
    const meter = browserMeterRef.current;
    browserMeterRef.current = null;
    if (meter?.frame != null) cancelAnimationFrame(meter.frame);
    meter?.stream?.getTracks().forEach((track) => track.stop());
    if (meter?.context) void meter.context.close().catch(() => undefined);
    setBrowserVoiceLevel(0);
  }, []);

  const startBrowserVoiceMeter = useCallback(async () => {
    if (Platform.OS !== "web" || !globalThis.navigator?.mediaDevices?.getUserMedia) return;
    stopBrowserVoiceMeter();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
      if (!AudioContextCtor) { stream.getTracks().forEach((track) => track.stop()); return; }
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const meter: { stream?: MediaStream; context?: AudioContext; frame?: number } = { stream, context };
      browserMeterRef.current = meter;
      const tick = () => {
        if (browserMeterRef.current !== meter) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) { const normalized = (sample - 128) / 128; sum += normalized * normalized; }
        const rms = Math.sqrt(sum / samples.length);
        setBrowserVoiceLevel(Math.min(1, rms * 8));
        meter.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Recording still works through expo-audio; the meter is best-effort browser UI.
    }
  }, [stopBrowserVoiceMeter]);

  useEffect(() => () => stopBrowserVoiceMeter(), [stopBrowserVoiceMeter]);

  const startVoiceRecording = useCallback(async () => {
    if (!activeProfile || voiceRecording || transcribingVoice) return;
    const traceId = newVoiceTraceId();
    voiceTraceIdRef.current = traceId;
    voiceTrace(traceId, "record_start_requested", { conversationId: params.conversationId });
    setVoiceError(null);
    const permission = await requestRecordingPermissionsAsync();
    voiceTrace(traceId, "record_permission", { granted: permission.granted });
    if (!permission.granted) {
      setVoiceError("Microphone permission is required for voice messages.");
      return;
    }
    // Voice input owns the audio session while the recorder/transcription box is
    // active. Pause any Milo speech immediately so the microphone cannot record
    // the app's own TTS, and hold subsequent assistant clips in the auto queue.
    voiceInputActiveRef.current = true;
    const activeVoicePlayer = voicePlayerRef.current;
    if (activeVoicePlayer?.playing) {
      activeVoicePlayer.pause();
      voicePausedForInputRef.current = true;
      setVoicePlaying(false);
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    voiceTrace(traceId, "recorder_prepare_begin");
    await recorder.prepareToRecordAsync();
    voiceTrace(traceId, "recorder_prepare_done");
    recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
    voiceTrace(traceId, "recorder_record_called");
    setVoiceRecording(true);
    if (Platform.OS === "web") void startBrowserVoiceMeter();
    haptic.tap();
  }, [activeProfile, voiceRecording, transcribingVoice, recorder, startBrowserVoiceMeter]);

  const cancelVoiceRecording = useCallback(async () => {
    try {
      if (recorderState.isRecording) await recorder.stop();
    } finally {
      stopBrowserVoiceMeter();
      voiceInputActiveRef.current = false;
      setVoiceRecording(false);
      setVoiceError(null);
      await setAudioModeAsync({ allowsRecording: false });
    }
  }, [recorder, recorderState.isRecording, stopBrowserVoiceMeter]);

  const finishVoiceRecording = useCallback(async () => {
    if (!activeProfile || finishingVoiceRef.current) return;
    const traceId = voiceTraceIdRef.current ?? newVoiceTraceId();
    voiceTraceIdRef.current = traceId;
    voiceTrace(traceId, "finish_requested", { isRecording: recorderState.isRecording, durationMillis: recorderState.durationMillis });
    finishingVoiceRef.current = true;
    setVoiceError(null);
    const durationSeconds = Math.max(0, recorderState.durationMillis / 1000);
    // Flip the UI immediately, before native audio finalization. Long recordings
    // can take noticeable time to close/write, and previously looked frozen here.
    stopBrowserVoiceMeter();
    voiceInputActiveRef.current = true;
    setVoiceRecording(false);
    setTranscribingVoice(true);
    setTranscriptionProgress({
      phase: "preparing",
      progress: 0,
      etaSeconds: null,
      elapsedSeconds: 0,
      audioDurationSeconds: durationSeconds || null,
      estimated: true,
    });
    let preparingTicker: ReturnType<typeof setInterval> | null = null;
    try {
      if (recorderState.isRecording) {
        const preparingStartedAt = Date.now();
        preparingTicker = setInterval(() => {
          setTranscriptionProgress({
            phase: "preparing",
            progress: 0,
            etaSeconds: null,
            elapsedSeconds: (Date.now() - preparingStartedAt) / 1000,
            audioDurationSeconds: durationSeconds || null,
            estimated: true,
          });
        }, 250);
        voiceTrace(traceId, "recorder_stop_begin");
        await recorder.stop();
        voiceTrace(traceId, "recorder_stop_done", { uriAvailable: Boolean(recorder.uri) });
        clearInterval(preparingTicker);
        preparingTicker = null;
      }
      const uri = recorder.uri;
      voiceTrace(traceId, "recording_uri", { available: Boolean(uri) });
      if (!uri) throw new Error("The recording could not be saved.");
      const token = sessionRef.current?.authToken() ?? (await getSecret(activeProfile.id)) ?? "";
      if (!token && !isDesktopWeb) throw new Error("The Local Milo capability token is unavailable.");
      // Do not read the recorder's growing .m4a from a second FileHandle while
      // AVAudioRecorder owns it. That optimization proved unsafe on physical iOS
      // devices: a background read could overlap stop()/container finalization and
      // wedge the native audio/file path. Upload the completed file only after
      // recorder.stop() has returned; the XHR upload still reports real progress.
      voiceTrace(traceId, "transcribe_call_begin");
      const text = await transcribeVoice(uri, token, activeProfile.url, {
        durationSeconds,
        traceId,
        onProgress: (progress) => {
          voiceTrace(traceId, "ui_progress", { phase: progress.phase, progress: progress.progress });
          setTranscriptionProgress(progress);
        },
      });
      voiceTrace(traceId, "transcribe_call_done", { textLength: text.length });
      if (voiceAutoSend) {
        const session = sessionRef.current;
        if (!session) throw new Error("Milo's chat session is not ready yet.");
        followLiveRef.current = true;
        nearBottomRef.current = true;
        setNearBottom(true);
        voiceTrace(traceId, "autosend_begin", { textLength: text.length });
        const sent = await session.send(text);
        voiceTrace(traceId, "autosend_result", { sent });
        if (!sent) {
          throw new Error("Transcription completed, but the chat send failed. Your transcript is preserved as an unsent message below; tap Retry to send it again.");
        }
        requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
      } else {
        // Programmatic transcription replacement can otherwise briefly retain
        // the previous textarea measurement. Reset to one line first; the
        // browser's onContentSizeChange immediately expands it again if the
        // inserted transcript actually wraps.
        if (isDesktopWeb) setDesktopInputContentHeight(21 * desktopTextScale);
        setDraft(text);
      }
    } catch (error) {
      voiceTrace(traceId, "voice_flow_error", { message: error instanceof Error ? error.message : String(error) });
      setVoiceError(error instanceof Error ? error.message : "Voice transcription failed.");
    } finally {
      if (preparingTicker) clearInterval(preparingTicker);
      finishingVoiceRef.current = false;
      voiceInputActiveRef.current = false;
      setTranscribingVoice(false);
      setTranscriptionProgress(null);
      await setAudioModeAsync({ allowsRecording: false });
      voiceTrace(traceId, "voice_flow_finally");
      voiceTraceIdRef.current = null;
    }
  }, [activeProfile, recorder, recorderState.isRecording, recorderState.durationMillis, voiceAutoSend, isDesktopWeb, desktopTextScale, stopBrowserVoiceMeter]);

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
      const officeBrowser = Platform.OS === "web" && activeProfile.id === "profile-local-milo-office";
      if (!token && !officeBrowser) throw new Error("The Local Milo capability token is unavailable.");
      const source = officeBrowser ? officeBrowserSpeechSource(text) : speechSource(text, token, activeProfile.url);
      const player = createAudioPlayer(source, { updateInterval: 150 });
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
          voicePlayerSubRef.current?.remove();
          voicePlayerSubRef.current = null;
          try { voicePlayerRef.current?.remove(); } catch { /* already released */ }
          voicePlayerRef.current = null;
          setVoiceProgress({ current: 0, duration: 0 });
          const next = voiceAutoQueueRef.current[0];
          if (next) {
            // Assistant prose can finish in several blocks while Milo continues
            // thinking or running tools. Never replace a clip that is already
            // being spoken; and while voice input owns the mic, leave the next
            // clip queued until recording/transcription has fully closed.
            if (!voiceInputActiveRef.current) {
              voiceAutoQueueRef.current.shift();
              setTimeout(() => { void playVoiceTextRef.current?.(next); }, 60);
            }
          } else {
            scheduleVoiceReplyCollapse(0);
          }
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
  playVoiceTextRef.current = playVoiceText;

  const enqueueAutoVoiceText = useCallback((text: string) => {
    if (!text.trim()) return;
    // Only protocol-final assistant text reaches this queue. Playback ordering is
    // driven by the native player's completion callback, never by network quiet
    // periods or guessed message-boundary delays.
    if (voiceInputActiveRef.current || voicePlayerRef.current || voicePlaying || voiceAutoQueueRef.current.length > 0) {
      voiceAutoQueueRef.current.push(text);
      return;
    }
    void playVoiceText(text);
  }, [playVoiceText, voicePlaying]);

  // Keep the completion listener stable across ChatSession lifetime changes. The
  // Agent SDK emits this only after a terminal stop/result transition, so this
  // path has no transcript-settle or network-latency timer.
  voiceModeRef.current = voiceMode;
  voiceModeLoadedRef.current = voiceModeLoaded;
  voiceCompletionHandlerRef.current = (completion) => {
    if (!voiceModeLoadedRef.current) {
      pendingVoiceCompletionsRef.current.push(completion);
      return;
    }
    const mode = voiceModeRef.current;
    if (mode === "off") return;
    const speakableText = prepareSpeechText(completion.text);
    clearVoiceDismissTimer();
    if (mode !== "auto") retireVoicePlayer();
    if (!speakableText) {
      setVoiceReply(null);
      return;
    }
    setVoiceReply({ id: completion.id, text: speakableText });
    if (mode === "auto") enqueueAutoVoiceText(speakableText);
    else scheduleVoiceReplyCollapse(15000);
  };

  useEffect(() => {
    if (!voiceModeLoaded) return;
    const pending = pendingVoiceCompletionsRef.current.splice(0);
    for (const completion of pending) voiceCompletionHandlerRef.current(completion);
  }, [voiceModeLoaded]);

  useEffect(() => {
    const inputActive = voiceRecording || transcribingVoice;
    voiceInputActiveRef.current = inputActive;
    if (inputActive) return;

    // The voice-input sheet has fully closed. Resume a clip that was paused
    // specifically for recording; otherwise drain the assistant TTS queue.
    if (voicePausedForInputRef.current && voicePlayerRef.current) {
      voicePausedForInputRef.current = false;
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).then(() => {
        if (voiceInputActiveRef.current || !voicePlayerRef.current) return;
        voicePlayerRef.current.play();
        setVoicePlaying(true);
      });
      return;
    }
    voicePausedForInputRef.current = false;
    if (!voicePlayerRef.current) {
      const next = voiceAutoQueueRef.current.shift();
      if (next) void playVoiceTextRef.current?.(next);
    }
  }, [voiceRecording, transcribingVoice]);

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
const attachImage = useCallback(async () => {
    haptic.tap();
    const picked = await pickImages();
    if (picked.length > 0) setAttachments((current) => [...current, ...picked].slice(0, 4));
  }, []);

  const attachAudio = useCallback(async () => {
    haptic.tap();
    const picked = await pickAudio();
    if (picked.length > 0) setAudioQueue((current) => [...current, ...picked].slice(0, 4));
  }, []);

  const attach = useCallback(() => {
    haptic.tap();
    attachMenuSheetRef.current?.present();
  }, []);

  // Upload a picked recording to the voice gateway (Whisper) and send the
  // transcript as a normal text message. The original audio stays on rgserver
  // (voice-gateway/uploads) so it can be attached to whatever we file it into.
  const sendAudioTranscript = useCallback(
    async (audio: AudioAttachment) => {
      const session = sessionRef.current;
      if (!session || !activeProfile) throw new Error("Milo's chat session is not ready yet.");
      const token = sessionRef.current?.authToken() ?? (await getSecret(activeProfile.id)) ?? "";
      if (!token) throw new Error("The Local Milo capability token is unavailable.");
      followLiveRef.current = true;
      nearBottomRef.current = true;
      setNearBottom(true);
      const text = await transcribeVoice(audio.uri, token, activeProfile.url, {});
      // Prefix the transcript with the source filename so the origin is clear in
      // the conversation. Jason's note (if any) travels as a separate message.
      await session.send(`Transcribed from "${audio.name}":\n\n${text}`);
    },
    [activeProfile, getSecret],
  );

  const sendQueuedAudio = useCallback(async () => {
    if (audioQueue.length === 0) return;
    const items = audioQueue;
    setAudioQueue([]);
    setTranscribingAudio(true);
    for (const audio of items) {
      try {
        await sendAudioTranscript(audio);
      } catch (e) {
        setVoiceError(e instanceof Error ? e.message : "Audio transcription failed.");
      }
    }
    setTranscribingAudio(false);
  }, [audioQueue, sendAudioTranscript]);
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
  const lastScrollOffsetRef = useRef(0);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const attachMenuSheetRef = useRef<BottomSheetModal>(null);
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
    let unsubscribeVoice: (() => void) | null = null;
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
        unsubscribeVoice = session.subscribeVoiceCompletions((completion) => {
          voiceCompletionHandlerRef.current(completion);
        });
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
      unsubscribeVoice?.();
      pendingVoiceCompletionsRef.current = [];
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
  const desktopComposerExpanded = isDesktopWeb && draft.trim().length > 0 && desktopInputContentHeight > (38 * desktopTextScale);

  useEffect(() => {
    if (!isDesktopWeb || draft.length > 0) return;
    setDesktopInputContentHeight(21 * desktopTextScale);
  }, [isDesktopWeb, draft, desktopTextScale]);
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

  // A server-side turn_end hook delivers notifications after iOS suspends the
  // app. Opening a remote conversation subscribes this physical Bloop install
  // to that conversation and refreshes its current title for notification UI.
  useEffect(() => {
    if (activeProfile?.type !== "remote" || !params.conversationId || !params.agentId) return;
    let cancelled = false;
    void (async () => {
      const capabilityToken = sessionRef.current?.authToken() ?? (await getSecret(activeProfile.id)) ?? "";
      if (!capabilityToken || cancelled) return;
      await registerConversationPush({
        capabilityToken,
        serverUrl: activeProfile.url,
        conversationId: params.conversationId,
        agentId: params.agentId,
        agentName,
        title,
      });
    })();
    return () => { cancelled = true; };
  }, [activeProfile, params.conversationId, params.agentId, agentName, title]);

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
  const onUserRemove = useCallback((id: string) => {
    haptic.tap();
    void sessionRef.current?.removeFailedSend(id);
  }, []);
  const onUserCancel = useCallback((id: string) => {
    haptic.tap();
    void sessionRef.current?.cancelPendingSend(id);
  }, []);

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
        onUserRemove={onUserRemove}
        onUserCancel={onUserCancel}
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

  // Voice recording/playback/progress state updates at high frequency. Keep the
  // expensive transcript list as a stable React subtree unless inputs that can
  // actually change the list change; this prevents 10 Hz voice UI ticks from
  // making VirtualizedList revisit a long conversation.
  const transcriptList = useMemo(
    () =>
      snapshot.hydrating ? (
                  <SkeletonList rows={4} avatar={false} />
                ) : (
                  <FlatList
                  ref={listRef}
                  data={listData}
                  inverted
                  keyExtractor={(item) => item.id}
                  renderItem={renderItem}
                  contentContainerStyle={[
                    styles.transcript,
                    isDesktopWeb && styles.transcriptDesktop,
                    isDesktopWeb ? { paddingTop: Math.max(170, desktopComposerHeight + 22) } : undefined,
                  ]}
                  // Virtualization tuned like paseo's native strategy: enough rows
                  // up front that a fast scroll into history doesn't blank, and a
                  // wide window so streaming flushes never evict nearby cells.
                  initialNumToRender={14}
                  maxToRenderPerBatch={12}
                  windowSize={9}
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
                    if (nearBottomRef.current !== nearBottom) {
                      nearBottomRef.current = nearBottom;
                      setNearBottom(nearBottom);
                    }
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
                    if (nearBottomRef.current !== nearBottom) {
                      nearBottomRef.current = nearBottom;
                      setNearBottom(nearBottom);
                    }
                    followLiveRef.current = atLiveEdge;
                    userScrollingRef.current = false;
                    if (atLiveEdge) scrollToLatest(false);
                  }}
                  {...(isDesktopWeb ? ({
                    onWheel: () => {
                      // RN Web's inverted list can receive content-size updates in
                      // the same frame as a wheel event. Freeze follow mode before
                      // the browser applies the wheel delta so streaming growth can
                      // never fight the reader and appear to scroll backwards.
                      userScrollingRef.current = true;
                      followLiveRef.current = false;
                      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
                      wheelIdleTimerRef.current = setTimeout(() => {
                        userScrollingRef.current = false;
                        if (lastScrollOffsetRef.current <= 2) followLiveRef.current = true;
                      }, 140);
                    },
                  } as any) : {})}
                  onScroll={(e) => {
                    const offset = Math.max(0, e.nativeEvent.contentOffset.y);
                    lastScrollOffsetRef.current = offset;
                    const nearBottom = offset < 80;
                    if (nearBottomRef.current !== nearBottom) {
                      nearBottomRef.current = nearBottom;
                      setNearBottom(nearBottom);
                    }
      
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
                ),
    [
      snapshot.hydrating,
      snapshot.loadingOlder,
      listData,
      renderItem,
      waitingForModel,
      agentName,
      colors.ink3,
      scrollToLatest,
      isDesktopWeb,
      desktopComposerHeight,
    ],
  );

  // Transient link states read as "working", not "broken" — only a genuine
  // loss of connectivity or bad credentials earns the danger tone.
  const status = statusFor(snapshot.run, snapshot.connection);

  return (
    <Screen>
      <View style={styles.desktopShell}>
        {isDesktopWeb ? (
          <DesktopConversationSidebar
            visible={desktopDrawerOpen}
            onClose={() => setDesktopDrawerOpen(false)}
            agentId={params.agentId}
            agentName={agentName}
            currentConversationId={params.conversationId}
          />
        ) : null}
        <View style={styles.desktopMain}>
      {isDesktopWeb ? (
        <View style={[styles.desktopTopBar, { backgroundColor: colors.bg, borderColor: colors.surfaceEdge }]}>
          {!desktopDrawerOpen ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Show conversations"
              onPress={() => setDesktopDrawerOpen(true)}
              style={[styles.desktopMenuButton, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
            >
              <Text role="title" ink={2}>☰</Text>
            </Touchable>
          ) : null}
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Conversation status and context usage"
            onPress={openConversationStatus}
            style={styles.desktopTitleLine}
          >
            <Text role="bodyEm" numberOfLines={1} style={styles.desktopTitleText}>{title}</Text>
            <View style={styles.desktopInlineStatus}>
              <StatusDot tone={status.tone} />
              <Text role="micro" ink={3} numberOfLines={1}>{agentName} · {status.label}</Text>
            </View>
          </Touchable>
          <View style={styles.desktopFontControlsInline}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Decrease chat font size"
              disabled={desktopTextScale <= DESKTOP_TEXT_SCALE_MIN}
              onPress={() => adjustDesktopTextScale(-DESKTOP_TEXT_SCALE_STEP)}
              style={styles.desktopFontButton}
            >
              <Text role="bodyEm" ink={desktopTextScale <= DESKTOP_TEXT_SCALE_MIN ? 3 : 2}>A−</Text>
            </Touchable>
            <Text role="micro" ink={3}>{Math.round(desktopTextScale * 100)}%</Text>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Increase chat font size"
              disabled={desktopTextScale >= DESKTOP_TEXT_SCALE_MAX}
              onPress={() => adjustDesktopTextScale(DESKTOP_TEXT_SCALE_STEP)}
              style={styles.desktopFontButton}
            >
              <Text role="bodyEm" ink={desktopTextScale >= DESKTOP_TEXT_SCALE_MAX ? 3 : 2}>A+</Text>
            </Touchable>
          </View>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Voice output: ${voiceMode}. Click to change`}
            onPress={cycleVoiceMode}
            style={styles.desktopVoiceLink}
          >
            <View style={styles.voiceModeContent}>
              <SpeakerIcon color={voiceMode === "auto" ? colors.accent : colors.ink2} muted={voiceMode === "off"} />
              <Text role="sub" tone={voiceMode === "auto" ? "accent" : undefined}>{voiceMode === "tap" ? "Click" : voiceModeLabel(voiceMode)}</Text>
            </View>
          </Touchable>
        </View>
      ) : (
        <Header
          title={title}
          back
          subtitle={
            <View style={styles.statusRow}>
              <Text role="sub" ink={2}>{agentName} · {status.label}</Text>
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
                <SpeakerIcon color={voiceMode === "auto" ? colors.accent : colors.ink2} muted={voiceMode === "off"} />
                <Text role="sub" tone={voiceMode === "auto" ? "accent" : undefined}>{voiceModeLabel(voiceMode)}</Text>
              </View>
            </Touchable>
          }
        />
      )}
      <View style={styles.desktopChatFrame}>
      <TextScaleProvider scale={isDesktopWeb ? desktopTextScale : 1}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? -insets.bottom : 0}
        style={styles.flex}
      >
        <View style={styles.flex}>
          {transcriptList}
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

        {isDesktopWeb ? (
          <View
            pointerEvents="none"
            style={[
              styles.desktopComposerFade,
              { height: Math.max(150, desktopComposerHeight + 18) },
              { backgroundImage: `linear-gradient(to bottom, transparent 0%, ${colors.bg} 55%, ${colors.bg} 100%)` } as never,
            ]}
          />
        ) : null}

        <View
          onLayout={isDesktopWeb ? (event) => {
            const next = Math.ceil(event.nativeEvent.layout.height);
            setDesktopComposerHeight((current) => Math.abs(current - next) > 1 ? next : current);
          } : undefined}
          style={[
            styles.composerWrap,
            isDesktopWeb && styles.composerWrapDesktop,
            {
              borderColor: colors.surfaceEdge,
              paddingTop: isDesktopWeb ? 2 : space.md,
              paddingBottom: isDesktopWeb ? 1 : Math.max(insets.bottom, space.md),
              gap: isDesktopWeb ? 1 : space.sm,
            },
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
          {audioQueue.length > 0 && snapshot.approvals.length === 0 ? (
            <View style={[styles.attachRow, { alignItems: "center" }]}>
              {audioQueue.map((a) => (
                <Touchable
                  key={a.id}
                  accessibilityRole="button"
                  accessibilityLabel="Remove audio"
                  onPress={() => setAudioQueue((current) => current.filter((c) => c.id !== a.id))}
                  style={[styles.attachChip, { flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.sm, backgroundColor: colors.surface, borderColor: colors.surfaceEdge, borderWidth: 1 }]}
                >
                  <Text role="micro" ink={2} style={{ flexShrink: 1 }}>
                    🎙 {a.name.length > 16 ? a.name.slice(0, 13) + "…" : a.name}
                  </Text>
                  <Text role="micro" ink={3} style={{ marginLeft: space.xs }}>
                    ✕
                  </Text>
                </Touchable>
              ))}
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Send audio for transcription"
                onPress={() => void sendQueuedAudio()}
                disabled={transcribingAudio}
                style={[{ backgroundColor: colors.accent }, styles.attachSend]}
              >
                <Text role="micro" ink={1}>
                  {transcribingAudio ? "Transcribing…" : "Send"}
                </Text>
              </Touchable>
            </View>
          ) : null}
          {voiceRecording || transcribingVoice ? (
            <Animated.View
              entering={FadeInDown.duration(190)}
              exiting={FadeOutDown.duration(150)}
              style={[
                styles.voiceRecorderPanel,
                isDesktopWeb && styles.voicePanelDesktop,
                { backgroundColor: colors.surface, borderColor: colors.surfaceEdge },
              ]}
            >
              {transcribingVoice ? (
                <>
                  <Text role="bodyEm" tone="accent">
                    {transcriptionProgress?.phase === "preparing"
                      ? "Preparing recording…"
                      : transcriptionProgress?.phase === "uploading"
                        ? "Uploading voice message…"
                        : transcriptionProgress?.phase === "finishing"
                          ? "Finishing transcription…"
                          : "Transcribing…"}
                  </Text>
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
                    {transcriptionProgress?.phase === "preparing"
                      ? `Saving the recording before upload…${transcriptionProgress.elapsedSeconds ? ` ${Math.ceil(transcriptionProgress.elapsedSeconds)}s elapsed` : ""}`
                      : transcriptionProgress?.etaSeconds === null || transcriptionProgress?.etaSeconds === undefined
                        ? transcriptionProgress?.phase === "uploading"
                          ? `Uploading…${transcriptionProgress.elapsedSeconds ? ` ${Math.ceil(transcriptionProgress.elapsedSeconds)}s elapsed` : ""}`
                          : "Estimating time remaining…"
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
                      const level = Platform.OS === "web"
                        ? Math.max(0.15, browserVoiceLevel)
                        : Math.max(0.15, Math.min(1, ((recorderState.metering ?? -52) + 60) / 42));
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
            </Animated.View>
          ) : null}
          {voiceMode !== "off" && voiceReply && !voiceRecording ? (
            <Animated.View
              entering={FadeInDown.duration(190)}
              exiting={FadeOutDown.duration(150)}
              style={[
                styles.voiceReplyCard,
                isDesktopWeb && styles.voicePanelDesktop,
                { backgroundColor: colors.surface, borderColor: colors.surfaceEdge },
              ]}
            >
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
            </Animated.View>
          ) : null}
          {voiceError ? <Text role="sub" tone="danger">{voiceError}</Text> : null}
          <View
            style={[
              styles.composer,
              isDesktopWeb && styles.composerDesktop,
              desktopComposerExpanded && styles.composerDesktopExpanded,
              { backgroundColor: colors.surface, borderColor: colors.surfaceEdge },
              snapshot.approvals.length > 0 && styles.hidden,
            ]}
          >
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Attach a photo or audio"
              onPress={() => attach()}
              disabled={snapshot.hydrating || (attachments.length + audioQueue.length) >= 4 || transcribingAudio}
              style={[
                styles.attachButton,
                isDesktopWeb && styles.composerAttachDesktop,
                desktopComposerExpanded && styles.composerAttachDesktopExpanded,
              ]}
            >
              <Text
                role="title"
                ink={(attachments.length + audioQueue.length) >= 4 || transcribingAudio ? 3 : 2}
                style={isDesktopWeb ? styles.composerPlusGlyphDesktop : undefined}
              >
                ＋
              </Text>
            </Touchable>
            <TextInput
              value={draft}
              onChangeText={editDraft}
              placeholder={running ? "Add a follow-up…" : `Message ${agentName}…`}
              placeholderTextColor={colors.ink3}
              style={[
                styles.input,
                { color: colors.ink },
                isDesktopWeb ? {
                  fontSize: 16 * desktopTextScale,
                  lineHeight: 21 * desktopTextScale,
                  outlineStyle: "none" as never,
                  paddingTop: desktopComposerExpanded ? 10 : 8,
                  paddingBottom: desktopComposerExpanded ? 10 : 7,
                  paddingLeft: desktopComposerExpanded ? 5 : 4,
                  paddingRight: desktopComposerExpanded ? 5 : 4,
                  height: desktopComposerExpanded ? undefined : 40,
                  minHeight: desktopComposerExpanded ? Math.min(126, Math.max(54, desktopInputContentHeight + 20)) : 40,
                  maxHeight: desktopComposerExpanded ? 126 : 40,
                  boxSizing: "border-box" as never,
                } : undefined,
                desktopComposerExpanded && styles.inputDesktopExpanded,
              ]}
              multiline
              scrollEnabled
              editable={!snapshot.hydrating}
              onContentSizeChange={isDesktopWeb ? (event) => {
                const next = Math.ceil(event.nativeEvent.contentSize.height);
                setDesktopInputContentHeight((current) => Math.abs(current - next) > 1 ? next : current);
              } : undefined}
              onKeyPress={onComposerKeyPress}
            />
            <View style={[
              styles.composerRightActions,
              isDesktopWeb && styles.composerRightActionsDesktop,
              desktopComposerExpanded && styles.composerRightActionsDesktopExpanded,
            ]}>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Record voice message"
                disabled={snapshot.hydrating || transcribingVoice}
                onPress={() => void startVoiceRecording()}
                style={[
                  styles.micButton,
                  isDesktopWeb && styles.composerIconDesktop,
                  isDesktopWeb && styles.micButtonDesktop,
                  { backgroundColor: voiceRecording ? colors.accent : colors.bubble, borderColor: voiceRecording ? colors.accent : colors.surfaceEdge },
                ]}
              >
                <View style={isDesktopWeb ? styles.micGlyphDesktop : undefined}><MicrophoneIcon color={voiceRecording ? "#FFFFFF" : colors.ink2} /></View>
              </Touchable>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={running ? "Stop" : "Send"}
                disabled={aborting || (!running && !canSend)}
                onPress={onPrimaryAction}
                style={[styles.composerSendTouch, isDesktopWeb && styles.composerSendTouchDesktop]}
              >
                <Animated.View
                  style={[
                    styles.send,
                    isDesktopWeb && styles.composerIconDesktop,
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
          </View>
          <View style={styles.chipRow}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`Model ${model ?? "default"}${effort ? `, effort ${effort}` : ""}. Change model`}
              onPress={openModelSheet}
              style={styles.modelChip}
            >
              <View style={styles.controlLabelInline}>
                <Text role="sub" ink={2} mono numberOfLines={1}>
                  {modelSaving ? "Saving…" : model ? model.split("/").pop() : "model"}
                  {!modelSaving && effort ? ` · ${effort}` : ""}
                </Text>
                <Text role="micro" ink={3}>⌄</Text>
              </View>
            </Touchable>
            {snapshot.device ? (
              <>
                <Text role="micro" ink={3} style={styles.controlSeparator}>|</Text>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Permission mode: ${snapshot.device.permissionMode}. Change controls`}
                  onPress={() => {
                    dismissChatKeyboard();
                    controlsSheetRef.current?.present();
                  }}
                  style={styles.modelChip}
                >
                  <View style={styles.controlLabelInline}>
                    <Text role="sub" ink={2} mono>
                      {snapshot.device.permissionMode === "acceptEdits"
                        ? "Accept edits"
                        : snapshot.device.permissionMode === "unrestricted"
                          ? "Unrestricted"
                          : "Standard"}
                    </Text>
                    <Text role="micro" ink={3}>⌄</Text>
                  </View>
                </Touchable>
              </>
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
      </TextScaleProvider>
      </View>
        </View>
      </View>
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
<Sheet ref={attachMenuSheetRef} title="Attach" compact>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Attach a photo"
          onPress={() => void attachImage()}
          style={styles.attachMenuRow}
        >
          <View style={styles.attachMenuIcon}><PhotoIcon color={colors.ink2} size={21} /></View>
          <View style={styles.attachMenuText}>
            <Text role="bodyEm">Photo</Text>
            <Text role="sub" ink={3}>From your library</Text>
          </View>
        </Touchable>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Attach a recording to transcribe"
          onPress={() => void attachAudio()}
          style={styles.attachMenuRow}
        >
          <View style={styles.attachMenuIcon}><MicrophoneIcon color={colors.ink2} size={21} /></View>
          <View style={styles.attachMenuText}>
            <Text role="bodyEm">Audio</Text>
            <Text role="sub" ink={3}>Pick a recording to transcribe</Text>
          </View>
        </Touchable>
      </Sheet>
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
            <Text role="sub" ink={3}>Reading Milo&apos;s current context…</Text>
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
  desktopShell: { flex: 1, width: "100%", flexDirection: "row" },
  desktopMain: { flex: 1, minWidth: 0, position: "relative" },
  desktopChatFrame: { flex: 1, width: "100%" },
  desktopTopBar: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 8,
    paddingVertical: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 4,
  },
  desktopTitleLine: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  desktopTitleText: { flexShrink: 1, minWidth: 0 },
  desktopInlineStatus: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 5, opacity: 0.82 },
  desktopVoiceLink: { flexShrink: 0, paddingHorizontal: 4, paddingVertical: 2 },
  desktopFontControlsInline: { flexShrink: 0, height: 26, flexDirection: "row", alignItems: "center", gap: 0, opacity: 0.66 },
  desktopFontButton: { minWidth: 27, minHeight: 26, alignItems: "center", justifyContent: "center" },
  desktopMenuButton: { minWidth: 30, minHeight: 30, alignItems: "center", justifyContent: "center", borderRadius: radius.chip },
  desktopSidebar: { width: 320, flexShrink: 0, borderRightWidth: StyleSheet.hairlineWidth },
  desktopSidebarHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  desktopSidebarTitle: { flex: 1, gap: 2 },
  desktopSidebarActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  desktopSidebarClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  desktopSidebarMessage: { padding: space.lg },
  desktopSidebarLoading: { padding: space.xl, alignItems: "center" },
  desktopSidebarList: { paddingVertical: space.sm },
  desktopSidebarRow: { paddingHorizontal: space.lg, paddingVertical: space.md, marginHorizontal: space.sm, borderRadius: radius.row },
  desktopContextMenu: { position: "fixed" as never, minWidth: 180, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, paddingVertical: space.xs, zIndex: 21, shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  desktopContextItem: { minHeight: 40, paddingHorizontal: space.md, justifyContent: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Inverted list: style paddingTop renders at the VISUAL bottom (above the
  // composer), paddingBottom at the visual top.
  transcript: { paddingHorizontal: space.gutter, paddingTop: space.xl, paddingBottom: space.md, gap: space.md },
  transcriptDesktop: {
    width: "100%",
    maxWidth: 900,
    alignSelf: "center",
    // Inverted list: paddingTop is the visual bottom. This keeps the live edge
    // readable while still allowing older content to scroll beneath the fade.
    paddingTop: 170,
    paddingBottom: 118,
  },
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
  attachMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 58,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radius.row,
  },
  attachMenuIcon: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  attachMenuText: { flex: 1, gap: 1 },
  attachSend: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.row,
    minHeight: 32,
  },
  latest: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.chip,
    paddingHorizontal: space.md,
    minHeight: 32,
  },
  composerWrap: {
    borderTopWidth: 0,
    paddingHorizontal: space.gutter,
    paddingTop: space.md,
    gap: space.sm,
  },
  desktopComposerFade: {
    position: "absolute",
    left: 0,
    right: 18,
    bottom: 0,
    height: 150,
    zIndex: 1,
  },
  composerWrapDesktop: {
    position: "absolute",
    left: "50%",
    bottom: 0,
    width: "100%",
    maxWidth: 900,
    transform: [{ translateX: "-50%" as never }],
    zIndex: 2,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  composerDesktop: { minHeight: 52, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, alignItems: "center" },
  composerDesktopExpanded: { minHeight: 92, borderRadius: 24, alignItems: "stretch", paddingTop: 7, paddingBottom: 43, position: "relative" },
  // ~7 lines before it scrolls: references cap growth near a third of the
  // screen so the transcript never disappears behind the composer.
  input: { flex: 1, minHeight: 38, fontSize: 16, lineHeight: 21, maxHeight: 168, paddingHorizontal: 0, paddingVertical: 8 },
  inputDesktopExpanded: { width: "100%", paddingHorizontal: 5, paddingRight: 5 },
  composerRightActions: { flexDirection: "row", alignItems: "center" },
  composerRightActionsDesktop: { gap: 6, alignItems: "center", marginRight: -5 },
  composerRightActionsDesktopExpanded: { position: "absolute", right: 8, bottom: 6, marginRight: 0 },
  composerAttachDesktop: { width: 40, height: 40, minHeight: 40, paddingRight: 0, alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: -6 },
  composerAttachDesktopExpanded: { position: "absolute", left: 9, bottom: 6, paddingRight: 0, width: 34, height: 34, alignItems: "center", justifyContent: "center", zIndex: 2, marginLeft: 0 },
  composerPlusGlyphDesktop: { fontSize: 20, lineHeight: 22, textAlign: "center", transform: [{ translateY: 1 }] },
  composerIconDesktop: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  micButtonDesktop: { width: 40, height: 40, minWidth: 40, minHeight: 40, maxWidth: 40, maxHeight: 40, borderRadius: 20, marginLeft: 0, padding: 0, aspectRatio: 1 },
  micGlyphDesktop: { transform: [{ translateX: 1.5 }] },
  composerSendTouchDesktop: { width: 40, height: 40, marginLeft: 0, alignItems: "center", justifyContent: "center" },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 16 },
  voiceModePill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.chip, paddingHorizontal: space.md, paddingVertical: 7 },
  voiceModeContent: { flexDirection: "row", alignItems: "center", gap: 7 },
  micButton: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", marginLeft: space.sm },
  voiceRecorderPanel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sheet, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, alignItems: "center" },
  voicePanelDesktop: { width: "74%", maxWidth: 660, alignSelf: "center" },
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
  modelChip: { maxWidth: 240, paddingVertical: 0 },
  controlLabelInline: { flexDirection: "row", alignItems: "center", gap: 4 },
  controlSeparator: { paddingHorizontal: 2, opacity: 0.55 },
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
