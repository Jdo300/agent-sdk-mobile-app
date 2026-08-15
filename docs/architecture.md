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
- The app never talks to Letta REST or app-server protocol endpoints directly.
- Missing portable behavior is fixed upstream in the Agent SDK.
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
6. On background or disconnect, preserve draft and rendered history, disable
   send, close the stale session, and enter reconnecting.
7. On foreground, create a fresh session for the same conversation, reconcile
   history and runtime snapshots, then enable send.

No message is automatically retried after an ambiguous post-send disconnect.
History is reconciled first to prevent duplicate user messages.

## Testing contract

The SDK adapter is dependency-injected so component and state tests never need
real credentials. Required fixtures cover:

- first connection;
- first message and streaming response;
- a running turn with two queued follow-ups;
- a pending approval;
- foreground reconnect and reconciliation.

Fixtures contain synthetic IDs and content only.
