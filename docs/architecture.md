# Architecture contract

## Purpose

This repository is a readable example of using the portable Letta Agent SDK
from an Expo application. It should remain small enough for downstream users
to fork and understand.

## Boundaries

```text
Expo screens
    ↓
feature hooks and view models
    ↓
portable SDK adapter
    ↓
@letta-ai/letta-agent-sdk/client
    ├── Cloud: fetch + status WebSocket
    └── Remote: Letta Code app-server WebSocket
```

- The app never imports the Node-focused package root.
- Prefer the portable Agent SDK for chat/session behavior. A narrowly scoped App Server
  management command is allowed when the portable client has no equivalent; Local Milo
  conversation deletion currently uses this path and is documented in
  `docs/local-milo-operations.md`.
- Missing portable behavior should still be fixed upstream when practical rather than
  growing parallel protocol implementations in the app.
- Credentials cross only the SecureStore/profile and SDK-construction
  boundaries.
- UI state may be optimistic only for local drafts and disclosure state.
  Run, queue, approval, abort, and reconnect state remains server-authoritative.

## Proposed source layout

```text
app/                    Expo Router screens
src/
  components/           reusable presentational components
  features/
    connections/        profiles, validation, SecureStore
    agents/             agent list and editor
    conversations/      conversation list and editor
    chat/               transcript, composer, controls, queue, approvals
  sdk/                  the only SDK-construction and session-lifecycle layer
  state/                small application stores and state machines
  theme/                tokens and accessibility-safe themes
  testing/              deterministic fixtures and render helpers
docs/                   design, capability, security, and provenance records
```

Use feature-local state unless multiple screens truly share it. Do not
reproduce the product-scale worker/controller architecture used by full Letta
applications.

## Session lifecycle

1. Read a redacted profile descriptor and credential from SecureStore. Refresh an OAuth
   access token when it is near expiry.
2. Construct one portable `LettaAgentClient`.
3. Select an agent and conversation through management namespaces.
4. Resume the conversation and hydrate history before enabling send.
5. Consume SDK events into a normalized transcript/run/queue projection.
6. A running conversation is retained independently of the mounted Chat screen, so
   navigation/backgrounding does not cancel server-side work or tear down a healthy
   stream just because the view disappeared.
7. On foreground or transport failure, first try to prove the existing transport healthy.
   Replace it only when it is dead or recovery requires a new transport. Reconcile device
   status and approvals server-authoritatively.
8. During an active recovered run, do **not** repeatedly rebase persisted history into
   the live transcript. Some anonymous live text deltas cannot be identity-matched to
   their later persisted message; mid-run rebasing can therefore create duplicate or
   out-of-order bubbles. Wait until the device reports idle, then perform authoritative
   history repair, followed by one bounded late-persistence pass.

No message is automatically retried after an ambiguous post-send disconnect. Optimistic
user echoes retire only when the persisted user row with the same OTID is observed.

## Testing contract

The SDK adapter is dependency-injected so component and state tests never need
real credentials. Required fixtures cover:

- first connection;
- first message and streaming response;
- a running turn with two queued follow-ups;
- a pending approval;
- foreground reconnect and reconciliation;
- reload during an active tool call;
- persisted-history reconstruction after reload;
- model/reasoning-effort persistence;
- transcript history rebase integrity.

`e2e/bloop-reliability.mjs` exercises the live web build against a real App Server. Its
conversation id and temporary diagnostics are local-only and ignored by Git. Fixtures
committed to the repo contain synthetic IDs and content only.
