# Local Milo / Bloop operations

This document is the repository-side operational reference for the Bloop client used with
Local Milo. It describes client behavior and recovery rules. Server deployment details remain
in the Local Milo App Server runbook on `rgserver`.

## Current Local Milo connection

Bloop connects to the Letta Code App Server as a remote profile. The capability token is stored
through the app's profile/SecureStore path; it must not be committed to this repository.

The iOS build permits local-network access because development and LAN operation can connect
directly to Local Milo services. Production/public access should use authenticated TLS (`wss`).

## Chat execution and lifecycle

- The server is authoritative for run state, queue state, approvals, abort completion, model
  state, and conversation history.
- A Chat screen can unmount while Milo keeps working. An active `ChatSession` is retained until
  the server-side run settles, and reopening the conversation attaches to that retained session.
- Foregrounding after a meaningful background interval triggers reconciliation. Bloop prefers
  the existing transport when it is healthy and replaces it only after a confirmed failure.
- A transport drop does not mark the server-side run failed. The UI reconnects and asks the
  executing device for current status.
- During reconnect catch-up, persisted history is **not rebased while the run is still
  processing**. This avoids duplicate/out-of-order bubbles when anonymous live text deltas do
  not share identity with their persisted form. Once the device reports idle, Bloop performs an
  authoritative tail repair and one delayed second pass for late persistence.
- Optimistic user bubbles are keyed by OTID and disappear only when an actual persisted user row
  with that OTID is present.
- Streaming tool groups remain structurally stable while a turn is active so rows do not jump
  around as more tool calls settle.

## Conversation management

Bloop supports create, rename, and delete for Local Milo conversations.

Conversation deletion is available from the conversation list by long-pressing the row and
choosing **Delete**. The UI removes the row optimistically and restores it if the server rejects
the operation. The App Server refuses deletion while that conversation has an active run.

The portable Agent SDK conversations client currently has no delete method for remote App Server
profiles. Bloop therefore uses a small authenticated App Server management command:

```text
conversation_delete -> conversation_delete_response
```

The matching Local Milo App Server support is applied by the reproducible server build patch
`patches/patch-conversation-delete-command.py` documented in the server runbook. Cloud profiles
continue to use the normal REST conversation-delete endpoint.

## Conversation status, model, and context

Tapping the chat title opens conversation status. It can show the active model, context-window
usage, estimated visible core-memory footprint, recent context growth, and the last reported
compaction. From there the conversation can be renamed or compacted when no run is active.

Reasoning effort and permission mode are persisted in the app and restored before a resumed
session is opened, preventing the model/permission controls from briefly showing stale defaults.
Changes still flow to the server and remain server-authoritative.

## Voice behavior

- Recording can run for up to 10 minutes.
- Optional **Auto-send** submits a successful transcription immediately.
- Starting a new recording stops current voice playback.
- Starting/replacing playback retires the previous native player first, preventing overlapping
  or spliced clips.
- Closing the voice reply stops playback immediately.

## Transcript UX

- User, assistant, reasoning, and tool rows carry stable display timestamps where available.
- Assistant messages can be copied as plain text or Markdown.
- Markdown/code presentation and full tool input/output views are preserved during streaming.
- Connection failures belong to connection UI rather than permanent transcript error rows.

## Reliability test

The reusable browser test is:

```bash
~/.bun/bin/bun e2e/bloop-reliability.mjs
```

It expects a running Bloop web build and an authenticated test configuration supplied through
environment variables/local files. It covers an optimistic send, assistant response, reload and
history reconstruction, reload during an active tool call, tool-card recovery, and reasoning
effort persistence.

Local files such as `e2e/.conversation-id` and one-off `.diag*.mjs` scripts are intentionally
ignored and must not be committed.

Before creating a rollback checkpoint, run at minimum:

```bash
npm run typecheck -- --pretty false
npm run lint -- --quiet
~/.bun/bin/bun test src/lib/letta/historyIntegrity.test.ts src/lib/letta/transcriptProjection.test.ts
```

Do not restart Expo, Metro, or the App Server merely to create a Git checkpoint while Milo is
actively working. A source commit is independent of those running processes.
