# Portable SDK capability matrix

Audited against
[`letta-agent-sdk@b5e1147`](https://github.com/letta-ai/letta-agent-sdk/commit/b5e114776c5921cb38eea061b1f45d5d6efb6cfc)
and its pinned `@letta-ai/letta-code@0.28.18` dependency.

Status meanings:

- **Available:** portable, typed API exists now.
- **SDK work:** underlying behavior exists, but the public portable API needs a
  typed helper.
- **App:** application lifecycle or presentation responsibility.
- **Deferred:** intentionally excluded from V1.

| Screen or control | Portable SDK operation/capability | Status | V1 behavior |
| --- | --- | --- | --- |
| Cloud profile | `new LettaAgentClient({ backend: "cloud", apiKey, webSocketAuth: "query" })` | Available | API key comes from SecureStore |
| Remote profile | `new LettaAgentClient({ backend: "remote", url, authToken, WebSocket })` plus `createReactNativeWebSocketConstructor()` | Available | Require WSS or private-network guidance outside development |
| Test connection | `client.agents.list({ limit: 1 })` | Available | Map auth, network, and protocol errors without including secrets |
| Agent list/search | `client.agents.list()` | Available | Cursor pagination and refresh |
| Agent retrieve | `client.agents.retrieve(agentId)` | Available | Hydrate the editor |
| Agent create | `client.createAgent()` | Available | Preserve centralized personality, MemFS, and origin-tag behavior |
| Agent edit | `client.agents.update()` | Available | V1 fields: name, description, model, tags, hidden, context limit |
| Conversation list/search | `client.conversations.list()` | Available | Filter by agent and summary |
| Conversation create | `client.conversations.create()` | Available | Create metadata without starting a run |
| Conversation retrieve | `client.conversations.retrieve()` | Available | Validate restored navigation |
| Conversation rename/edit | `client.conversations.update()` | Available | Summary and description |
| History pagination | `client.conversations.listMessages()` or `session.listMessages()` | Available | Use message IDs as cursors |
| Start/resume chat | `client.createSession()` / `client.resumeSession()` | Available | One owned session per open conversation |
| Send message | `session.send()` | Available | Do not retry automatically after ambiguous disconnect |
| Queue follow-up | `session.send()` during an active turn | Available | Server owns ordering |
| Queue display | `queue_update` SDK event with `SDKQueueItem[]` | Available | Replace the complete projection on each snapshot |
| Remove queued item | `remove_queue_item` protocol command | SDK work | Add typed `session.removeQueuedMessage(itemId)` and await its response |
| Edit queued item | Queue item content + typed removal | SDK work | Remove after acknowledgement, then restore content to composer |
| Steer active run | No confirmed portable capability | Deferred | Do not render the action |
| Stream assistant/reasoning/tools | `session.stream()` normalized SDK events | Available | Coalesce deltas by server identity |
| Approval prompt | session `canUseTool` callback | Available | Callback awaits an in-app allow/deny decision |
| Recover pending approval | concrete `recoverPendingApprovals()` exists but is absent from `LettaCodeSession` | SDK work | Expose typed method for reconnect |
| Abort | `session.abort()` | Available | Show aborting until authoritative terminal state |
| List models | `session.listModels()` | Available | Searchable model sheet |
| Model/reasoning update | `session.updateModel()` | Available | Disable while saving |
| Initial permission/cwd | `createSession()` / `resumeSession()` options | Available | Apply when opening the conversation |
| Change permission/cwd | concrete `changeDeviceState()` exists but is absent from `LettaCodeSession` | SDK work | Expose typed helper; do not send raw protocol from the app |
| Bootstrap/reconcile history | concrete `bootstrapState()` exists but is absent from `LettaCodeSession` | SDK work | Expose typed helper and reconcile before enabling send |
| Event sequence gaps | Cloud/app-server session recovery and sync behavior | Available + App | Enter reconciling; never silently append across a known gap |
| Foreground reconnect | Close stale session, resume conversation, bootstrap, restart event projection | App | Preserve draft/history; send remains disabled until reconciled |
| Secure credential storage | Expo SecureStore | App | Never place secrets in ordinary state persistence |
| Local execution | Node-only SDK package root | Deferred | Not offered in the app |

## Upstream requirement

Do not implement protocol commands directly in this app. Open a focused Agent
SDK PR for:

1. `bootstrapState()` on `LettaCodeSession`;
2. `changeDeviceState()` on `LettaCodeSession`;
3. `recoverPendingApprovals()` on `LettaCodeSession`;
4. `removeQueuedMessage(itemId)` with a typed acknowledgement.

Until that PR is merged and released, development may pin the Agent SDK commit.
The final public-ready dependency must use an npm release.

