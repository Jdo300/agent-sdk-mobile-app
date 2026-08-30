# Design

The design source of truth for this app: the visual system, screen map, wireframes,
motion and haptics, and — in Appendix A — the operation map from each screen to the
Agent SDK call behind it. Every SDK claim in that appendix was verified against the
`@letta-ai/letta-agent-sdk` source and the bundled `@letta-ai/letta-code` protocol
types rather than assumed, which is why a few entries read "does not exist".

## 1. Stance

**Calm surface, live core.** A Letta agent is a long-lived thing you have a relationship
with, not a search box. The app should feel like a quiet, well-made messages app that
happens to control an agent runtime — never like a terminal, a dashboard, or a demo.

Three principles, in priority order:

1. **Typography is the interface.** Hierarchy comes from type scale, weight, and space —
   not from boxes, borders, and fills. Assistant prose sits directly on the background.
   Chrome earns its pixels. (This is the Paseo lesson, re-expressed in Letta's voice.)
2. **Native feel is non-negotiable.** Every touch has a pressed state, every sheet is a
   spring, transitions track gestures, and the composer tracks the keyboard frame-for-frame.
   (This is the Remodex lesson — its polish comes from motion, not decoration.)
3. **The server is the truth.** Run state, queue order, approvals, and permission mode
   render only what the runtime confirms. The UI shows *pending*, never *pretend*.

Pedagogy follows from restraint: fewer components, each readable, each mapped 1:1 to an
SDK concept a downstream developer can find in Appendix A.

## 2. Visual language

### 2.1 Color

Neutral anchors: ink `#202020`, mist `#C9CDD1`. Nothing here is anyone's brand — fork
this and set your own.

Tokens (semantic, theme-resolved — components never use raw hex):

| Token          | Light                | Dark                 | Use |
| -------------- | -------------------- | -------------------- | --- |
| `bg`           | `#FBFBFA`            | `#161618`            | App background (slightly warm paper / near-black) |
| `surface`      | `#FFFFFF`            | `#1E1E21`            | Cards, sheets, composer |
| `surfaceEdge`  | `#ECEDEB`            | `#2A2A2E`            | Hairline borders (0.5pt) |
| `ink`          | `#202020`            | `#ECEDEF`            | Primary text |
| `ink2`         | `#5A5E63`            | `#A2A6AC`            | Secondary text, timestamps |
| `ink3`         | `#8B9096`            | `#6E7176`            | Tertiary: placeholders, disabled |
| `accent`       | `#3D6DFF` (fallback) | `#6E92FF` (fallback) | Actions, links, send, selection |
| `run`          | `#1FA97A`            | `#34C68F`            | Running / connected / success |
| `wait`         | `#C7841D`            | `#E3A33A`            | Reconnecting / pending approval |
| `danger`       | `#C93A2E`            | `#E8604F`            | Errors, destructive, deny |

Rules: one accent; semantic colors appear only as 6pt status dots, thin progress
treatments, and text on approval/error moments — never as large fills. Both themes must
pass WCAG AA for all text tokens on their backgrounds (verify in milestone 1 with a
contrast check script).

### 2.2 Type

System stack (SF Pro on iOS, Roboto on Android). No custom fonts shipped.

| Token       | Size/weight        | Use |
| ----------- | ------------------ | --- |
| `display`   | 28 / 700, -0.5     | Screen titles (Connect, Agents) |
| `title`     | 20 / 600           | Sheet titles, section heads |
| `body`      | 16 / 400, 1.45lh   | Assistant prose, form fields |
| `bodyEm`    | 16 / 600           | Row titles, buttons |
| `sub`       | 13 / 400           | Metadata, timestamps, helper copy |
| `micro`     | 11 / 500, +0.3, caps | Status labels, queue count |
| `mono`      | 13 / 400 mono      | Paths, model handles, raw tool I/O |

Assistant prose is `body` at 16/1.45 — reading comfort is the whole product. User bubbles
are `body` 15. Dynamic Type scales everything; layouts are tested at XL.

### 2.3 Space, shape, depth

- 4pt grid. Screen gutter 20. List row vertical padding 14. Section gap 28.
- Radii: rows/cards 12, sheets 24 (top), bubbles 18 (4 on the tail corner), chips 999.
- Depth: hairlines and background shifts, not shadows. Sheets get a single soft shadow +
  `expo-blur` backdrop. Nothing else floats.

### 2.4 Motion

All motion in Reanimated; one spring family so the app has one personality:

| Token      | Value                                  | Use |
| ---------- | -------------------------------------- | --- |
| `micro`    | timing 120ms ease-out                  | Pressed states, dot changes |
| `move`     | spring d=26 s=300 (≈240ms)             | Row insert/remove, capsule count, morphs |
| `sheet`    | spring d=28 s=260 + drag-to-dismiss    | All bottom sheets |
| `breathe`  | 1.6s ease-in-out loop, scale 1→1.06    | Streaming/typing indicator |
| `caret`    | 600ms opacity pulse                    | Streaming text caret |

Reduced-motion: springs become 80ms fades; `breathe`/`caret` become static glyphs.

### 2.5 Haptics map

`expo-haptics`, one place (`src/lib/haptics.ts`): send `impactLight` · stop
`impactMedium` · approve `notificationSuccess` · deny `notificationWarning` · queue
add/remove `selection` · reconnected `notificationSuccess` · error `notificationError`.
Never on stream deltas.

### 2.6 Identity

Monogram avatars stand in for agent art: a 2-letter monogram on a deterministic two-stop
glossy sphere ("bloop") in a solid color hashed from `agent_id` — twelve hues with a
lightness nudge so two agents on the same hue stay distinguishable. The app icon, splash
and Connect-screen mark are the same bloop, drawn from these tokens (see `docs/press`
section of the README); splash is `bg`-colored per theme so launch → app is seamless.

## 3. Navigation

Expo Router stack, one primary destination at a time:

```
Connect ─→ Agents ─→ Conversations ─→ Chat
   │           │            │            ├─ sheet: Model & reasoning
   │           │            │            ├─ sheet: Controls (permission · cwd)
   │           │            │            ├─ sheet: Queue
   │           │            │            ├─ sheet: Tool detail
   │           │            └─ sheet: New/rename conversation
   │           └─ sheet: New/edit agent
   └─ push: Profile editor (cloud | remote)
dev-only: /gallery (every component state, fixture-driven)
```

Launch with a saved active profile skips straight to Agents and restores the last
conversation if one was open (< 24h). Back is always a swipe. Tablets center content at
620pt max width; same topology.

## 4. Screens

Wireframes show hierarchy, not final pixels. All screens: light + dark, 320/375/430pt.

### 4.1 Connect

```
┌──────────────────────────────────────┐
│                                       │
│   ◍  Letta                            │   monogram-gradient mark, display type
│   Chat with your agents,              │   sub copy, ink2
│   anywhere.                           │
│                                       │
│   ┌─────────────────────────────┐     │
│   │ ☁  Letta Cloud           ›  │     │   surface card, 12r
│   │    Sign in or use an API key│     │
│   └─────────────────────────────┘     │
│   ┌─────────────────────────────┐     │
│   │ ⌂  Your own server       ›  │     │
│   │    Connect over WebSocket   │     │
│   └─────────────────────────────┘     │
│                                       │
│   SAVED                               │   micro caps, ink3
│   ● Personal Cloud            ›       │   run dot = last test ok
│   ○ Homeserver                ›       │
└──────────────────────────────────────┘
```

Profile editor (push): Cloud offers browser OAuth with PKCE first and an API key as the
secondary choice. The Cloud API host is fixed and is not shown in the form. Remote:
name, WebSocket URL, capability token (secure field). Below the remote fields, plain
`sub` copy: *"A remote server can run tools on that machine. Use wss:// or a private
network like Tailscale; plain ws:// is for development."* Primary action **Test
connection** runs a real handshake and reports specifically (unreachable / unauthorized /
ok + server version). **Save** enables after a successful test (override allowed via
"Save anyway"). Credentials live in `expo-secure-store` only; the form never re-displays
a stored secret, only `••••` + "Replace".

States: empty (no profiles → cards only), testing (inline spinner in button), auth error,
unreachable, saved-active.

### 4.2 Agents

```
┌──────────────────────────────────────┐
│ Personal Cloud ●                 ⚙   │   profile chip → switcher sheet
│ Agents                           ＋  │   display title
│ ┌ search ─────────────────────────┐  │
│                                       │
│ ◍ Ada                                │   monogram gradient 40pt
│    sonnet-4.6 · active 3m ago        │   sub: model handle mono-ish chip + recency
│                                       │
│ ◍ Release helper              ●      │   run dot when a conversation is running
│    gpt-5.6 · yesterday               │
└──────────────────────────────────────┘
```

Row tap → Conversations. Long-press → context menu (Edit, Delete with confirm). `＋` →
agent sheet: name, model (same model sheet as chat), optional system-prompt preset field —
only fields Appendix A confirms. Skeleton rows while loading; empty state: one line +
"Create your first agent".

### 4.3 Conversations

```
┌──────────────────────────────────────┐
│ ‹ Agents                              │
│ ◍ Ada                            ＋  │   agent identity carried in header
│                                       │
│ ● Fix reconnect banner                │   run dot + bodyEm title
│    Running · 2m                      │   sub, `run` colored word
│ ◔ Ship the queue sheet                │   wait glyph = pending approval
│    Needs approval · 12m              │
│   Onboarding copy pass                │
│    Yesterday                         │
└──────────────────────────────────────┘
```

Infinite scroll (cursor pagination). Swipe row → Rename / Delete. `＋` creates and enters
immediately (agent's default settings). Badges come from server state, not local guesses.

### 4.4 Chat — the product

```
┌──────────────────────────────────────┐
│ ‹  Fix reconnect banner          ⋮   │   title bodyEm; back swipe
│    Ada · Connected ●                 │   sub + status dot
├──────────────────────────────────────┤
│                        ┌───────────┐ │
│                        │ Try again │ │   user bubble, right, surface fill
│                        └───────────┘ │
│                                       │
│  Thought for 6s                    ›  │   ink2 sub, chevron expands
│  ┌ ▸ read_file · 0.8s ─────────────┐ │   tool card: hairline, mono summary
│  │  src/net/reconnect.ts            │ │
│  └──────────────────────────────────┘ │
│  The reconnect banner fails because   │   assistant prose, no box
│  the retry timer is cleared before…   │
│                                       │
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ Message Ada…                     │ │   surface composer, 18r
│ └──────────────────────────────────┘ │
│  sonnet-4.6 · high   ⚙ controls   ↑  │   chips (sub) + send
└──────────────────────────────────────┘
```

**Markdown & copy.** Assistant prose renders as markdown mapped onto the token system
(`react-native-markdown-display`): headings collapse to `title`/`bodyEm`, inline code sits
on the `pressed` tint in mono, fences become hairline `surface` cards (mono, horizontal
scroll, a quiet `micro` copy affordance top-right), links are `accent` and open via
`Linking`. While streaming, text splits into fence-aware blocks so settled blocks stay
memoized and only the tail re-parses; the pulsing caret sits on the line after the tail
block, terminal-style. Long-press an assistant block or user bubble to copy the raw text
(selection tick + transient "Copied" sub-label); copy is disabled mid-stream.

**Streaming.** Deltas append to one assistant block with the pulsing caret; the reasoning
row shows the breathing indicator, live elapsed seconds ticking on the wall clock (not
delta cadence), and a one-line tertiary preview of the newest thought — tap to expand the
full reasoning even mid-stream. Tool cards appear
with a soft `move` insert and a shimmer strip while pending, then settle to a status glyph
(✓ ink2 · ✗ danger) + duration. Autoscroll only if the user is within 80pt of the bottom;
otherwise a "↓ Latest" pill fades in above the composer. The send button morphs (`move`)
into a stop square for the whole run; a second affordance is never needed.

**Keyboard open.** Composer is keyboard-tracked via Reanimated (no jump-lag); the queue
capsule and status row stay visible above it; transcript bottom inset equals measured
composer stack height. Drafts survive keyboard dismiss, navigation, and reconnect
(in-memory + MMKV-free — plain state + AsyncStorage draft key is fine and pedagogical).

**Queue.** Sending during a run enqueues (server-confirmed):

```
│ ⧗ Queued 2 · "Then run the tests…" ›  │   capsule above composer, animates count
```

Tap → Queue sheet: ordered items, each with **Remove** (`remove_queue_item`) and **Edit &
resend** (remove + restore text to composer — labeled exactly that, since that's what it
does). Items show `pending` until the server's `update_queue` confirms mutation. Abort
never implies queue disposition; the sheet re-renders from the post-abort `update_queue`.

**Approvals.** A pending `can_use_tool` control request replaces the composer:

```
┌──────────────────────────────────────┐
│ APPROVAL · 1 OF 2                     │   micro caps, wait color
│ Run shell command                     │   title
│ `npm test -- reconnect`               │   mono, 2-line clamp → tap = detail sheet
│ Reason (optional)…                    │
│ ┌────────────┐  ┌──────────────────┐ │
│ │   Deny     │  │      Allow       │ │   danger-text ghost · accent fill
│ └────────────┘  └──────────────────┘ │
└──────────────────────────────────────┘
```

Detail sheet shows full input, `diffs` previews when present, and server
`permission_suggestions` as tappable rows. The originating tool card in the transcript
shows an "awaiting approval" state simultaneously. Multiple requests: position indicator,
resolved in order. Stop remains reachable in the header. Buttons show a submitting state;
the card leaves only on server confirmation.

**Reconnect.**

```
│ ◌ Reconnecting to Homeserver…         │   banner above composer, wait color
│    Your draft is safe.       Retry    │
```

States: reconnecting (auto, backoff shown after attempt 3) → reconciling ("Catching up…" —
sync + refetch before send re-enables) → connected (banner slides out, success haptic) or
offline (specific reason + Retry) or auth-failed (→ "Update connection" routes to the
profile editor, profile preserved). Transcript stays readable throughout; on `event_seq`
gap the client never splices — it enters reconciling and refetches.

### 4.5 Sheets

All sheets: `@gorhom/bottom-sheet`, 24r top, blur backdrop, drag-to-dismiss, title row.

- **Model & reasoning** — search field, model rows (label + mono handle + `free`/default
  badges from `list_models` entries), then an effort segment (low/medium/high) shown only
  when the selected model supports it. Saving state on the chip until
  `update_model_response` confirms; failure reverts with an inline error.
- **Controls** — permission mode as three radio rows with one-line consequences
  (Standard: "asks before risky tools" · Accept edits: "file edits auto-approved" ·
  Unrestricted: "everything auto-approved", danger-tinted) → `change_device_state`;
  working directory (mono text row, remote profiles only) → `change_device_state.cwd`;
  current values from `DeviceStatus`. Unsupported on this connection → row hidden, not
  disabled.
- **Queue / Tool detail / Profile switcher / Agent & conversation editors** — as above.

### 4.6 Gallery (dev-only)

`/gallery` renders every component in every state from fixtures (the mock transport's
vocabulary): all transcript rows, composer states, queue capsule counts, approval single/
multi, banners, skeletons, empty states — in both themes. This is where screenshots for
design review come from; it ships in the repo as living documentation but is excluded
from production nav.

## 5. Component inventory

| Component | States |
| --- | --- |
| `Screen` / `Header` | default, large-title collapse, status sub-row |
| `ProfileCard` / `ProfileRow` | idle, pressed, active, testing, error |
| `SecureField` | empty, editing, stored (`••••` + Replace) |
| `AgentRow` (`Monogram`) | idle, pressed, running-dot, skeleton |
| `ConversationRow` | idle, running, needs-approval, rename-pending, skeleton, swipe-open |
| `TranscriptList` | hydrating, ready, streaming, user-scrolled (+Latest pill), older-page loading |
| `UserBubble` | sent, pending, failed(retry), copied |
| `AssistantBlock` | streaming(caret), complete(markdown), interrupted, error, copied |
| `Markdown` / `CodeFence` | prose, list, quote, fence(copy/copied), inline code, link |
| `ReasoningRow` | thinking(breathe+ticking timer+tail preview), collapsed("Thought for Ns"), expanded (incl. mid-stream) |
| `ToolCard` | pending(shimmer), running, awaiting-approval, success, denied, error; collapsed/detail |
| `Composer` | empty, drafting, sending, run-active(queue mode), disabled(reconciling) |
| `SendStopButton` | send, morphing, stop, aborting(spinner) |
| `ChipRow` (model/effort/controls chips) | idle, saving, error-revert |
| `QueueCapsule` | hidden, count-n (animated), reconciling |
| `QueueSheet` item | confirmed, pending-mutation, removed(exit anim) |
| `ApprovalCard` | single, x-of-n, submitting-allow, submitting-deny, stale(superseded) |
| `Banner` | reconnecting, reconciling, offline, auth-failed, info |
| `SkeletonRow` / `EmptyState` / `InlineError` | per list · per screen · field/row/turn scope |

State ownership: one `ConnectionStore` (profile, socket lifecycle, `DeviceStatus`) and one
`ChatStore` per open conversation (transcript, run, queue, approvals) — plain reducers in
React context, no external state library. All mutations are command → pending → confirmed.

## 6. Event → presentation (verified names)

| Runtime signal | Source | Presentation |
| --- | --- | --- |
| `stream_event` text delta | SDK `session.stream()` | append to `AssistantBlock`, caret on |
| `reasoning` message / delta | stream | `ReasoningRow` live → collapsed summary |
| `tool_call` / `tool_result` | stream | `ToolCard` insert → settle (keyed by `tool_call_id`) |
| `queue_update` (`update_queue`) | stream | capsule + sheet re-render, server order |
| `loop_status` (`update_loop_status`) | stream | header status, running dot, composer mode |
| `control_request` `can_use_tool` | `canUseTool` callback | `ApprovalCard` replaces composer; card state on the tool |
| `result` | stream | run end: stop→send morph, elapsed in `sub` |
| `retry` / `error` | stream | inline turn error + retry affordance |
| `update_device_status` | control channel | permission/cwd chips, pending approvals on resume |
| socket close / `event_seq` gap | transport | `Banner` reconnecting → reconciling (sync + refetch) → ready |

## 7. Copy

Sentence case; verbs for actions (Connect, Test connection, Create agent, Send, Stop,
Allow, Deny, Remove, Retry). Say **conversation**, not thread/session. Stop ≠ Remove ≠
Deny — never share a label. Errors say what happened + one next step, in `sub`, no codes.
Never render an API key, token, or their prefixes anywhere, including errors and
accessibility labels.

## 8. Accessibility & responsiveness

- Test matrix: 320/375/430pt × light/dark × Dynamic Type XL, iOS + Android.
- 44pt minimum targets; safe areas + Android edge-to-edge.
- Color never carries state alone (dot + word). AA contrast both themes.
- Icon-only controls get labels + state; announce: run start/end, approval arrival, queue
  mutation failure, reconnect result. Never announce deltas.
- Reduced-motion per §2.4. Screen-reader order: header → transcript → banner/queue → composer.

## 9. Reference & license ledger

Patterns studied at pinned commits; **no code or assets** from any of them.

| Project | Commit | License | Taken (patterns only) | Rejected |
| --- | --- | --- | --- | --- |
| Paseo | `6563300` | AGPLv3 | calm list/detail, quiet dots, composer-embedded model control | panel machinery, provider trees |
| Remodex | `59ecd88` | Apache-2.0 (brand excluded) | motion feel, queue capsule/sheet, recovery card | glass UI, QR pairing, git/terminal |
| Litter | `abee3ac` | GPLv3+exception | server/recents split, collapsible tool cards | mono body, mascot, density |
| Synara | `54dff37` | MIT | combined model+effort picker, queued-item actions | desktop workspace |
| codex-web | `c3e92f0` | none found | remote-security posture | everything else |
| letta-cloud | `06649a0` | proprietary | UMI semantics (queue/approval/reconnect) via public protocol | all UI code |

## Appendix A — verified operation map

Verified 2026-07-25 against `letta-agent-sdk` +
`@letta-ai/letta-code` 0.28.x `protocol_v2.d.ts`. ✅ = SDK client API today ·
🔌 = protocol command via `session.sendCommand()` (wrap in `src/lib/letta/`, mark
`// TODO(sdk)`, log in SDK-FEEDBACK.md).

| Screen need | Operation | Status |
| --- | --- | --- |
| Cloud auth | `LettaAgentClient({backend:"cloud", apiKey, webSocketAuth:"query"})` | ✅ `/client` |
| Remote auth | `{backend:"remote", url, authToken}` (+ RN WS adapter for header auth) | ✅ `/client` |
| Create agent | `client.createAgent({model, …})` (cloud = REST, no local spawn) | ✅ |
| List/search agents | `agent_list` | 🔌 |
| Edit agent | `agent_update` | 🔌 |
| Delete agent | `agent_delete` | 🔌 |
| List conversations | `conversation_list` | 🔌 |
| Create conversation | `client.createSession(agentId)` / `conversation_create` | ✅/🔌 |
| Rename conversation | `conversation_update` (title in body) | 🔌 |
| History + pagination | `session.listMessages({before, limit})` / `conversation_messages_list` | ✅ |
| Send / stream / abort | `session.send()` / `session.stream()` / `session.abort()` | ✅ |
| Queue view | `queue_update` SDK messages | ✅ |
| Queue remove | `remove_queue_item` | 🔌 |
| Steering | — not in protocol — | ✖ omit (no fake UI) |
| Models list | `session.listModels()` (entries incl. label/handle/free) | ✅ |
| Model + effort | `session.updateModel({modelId, reasoningEffort})` | ✅ |
| Permission mode | `change_device_state {mode: standard\|acceptEdits\|unrestricted}` | 🔌 |
| Working directory | `change_device_state {cwd}` + `DeviceStatus.current_working_directory` | 🔌 |
| Approvals | `canUseTool` callback (`permission_suggestions`, `diffs`, `blocked_path`) | ✅ |
| Resume/reconcile | `sync` + `DeviceStatus.pending_control_requests` + seq tracking | 🔌 |

Every 🔌 row is a concrete upstream API request for the Agent SDK — the wrapper layer in
`src/lib/letta/` is both the app's adapter and the SDK team's backlog, file by file.

### Tool-call presentation hierarchy

Tool activity in the transcript is supervisory UI, not a terminal dump. Collapsed tool cards should answer **what the agent is doing** before exposing **how it is doing it**.

- Prefer explicit tool-provided `description`, `summary`, `purpose`, or `intent` metadata over raw command/path fields.
- When no description exists, derive a concise deterministic activity label from common tool semantics (for example, `Check repository status`, `Run tests`, `Read voice_gateway.py`, or `Search for “…”`). Do not invoke another model merely to label a tool card.
- Keep the underlying tool name/status/timing visible as secondary metadata.
- Full command/parameter payloads and complete outputs remain available in the detail sheet for debugging/auditability.
- Grouped settled-tool rows summarize the member activity descriptions rather than repeating opaque tool names such as `Bash, Bash, Read`.
- Unknown tools fall back to a humanized tool name rather than raw JSON in the collapsed transcript.
