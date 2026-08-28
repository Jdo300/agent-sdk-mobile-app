export function durableMessageId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function durableMessageOtid(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const otid = (message as { otid?: unknown }).otid;
  return typeof otid === "string" && otid.length > 0 ? otid : null;
}

export function newestDurableMessageId(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = durableMessageId(messages[i]);
    if (id) return id;
  }
  return null;
}

export function deriveDurableCursors(
  messages: readonly unknown[],
  nextBefore: string | null,
): { nextBefore: string | null; forwardAfter: string | null } {
  return { nextBefore, forwardAfter: newestDurableMessageId(messages) };
}

/** Append a forward-sync page without changing already-canonical order. */
export function mergeForwardMessages(
  current: readonly unknown[],
  incoming: readonly unknown[],
): unknown[] {
  if (incoming.length === 0) return [...current];
  const seen = new Set(current.map(durableMessageId).filter((id): id is string => Boolean(id)));
  const additions: unknown[] = [];
  for (const message of incoming) {
    const id = durableMessageId(message);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    additions.push(message);
  }
  return [...current, ...additions];
}

/** Prepend an older page without duplicating overlap rows. */
export function mergeBackwardMessages(
  current: readonly unknown[],
  incoming: readonly unknown[],
): unknown[] {
  if (incoming.length === 0) return [...current];
  const seen = new Set(current.map(durableMessageId).filter((id): id is string => Boolean(id)));
  const older = incoming.filter((message) => {
    const id = durableMessageId(message);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...older, ...current];
}

export function persistedUserOtids(messages: readonly unknown[]): string[] {
  const otids = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { message_type?: unknown; otid?: unknown };
    if (record.message_type === "user_message" && typeof record.otid === "string" && record.otid.length > 0) {
      otids.add(record.otid);
    }
  }
  return [...otids];
}
