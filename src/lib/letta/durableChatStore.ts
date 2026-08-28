import type { SQLiteDatabase } from "expo-sqlite";

import type { Attachment } from "./attachments";
import { durableMessageOtid, newestDurableMessageId, persistedUserOtids } from "./durableSyncCore";

const DB_NAME = "bloop-chat.db";
const SCHEMA_VERSION = 1;

export type DurableOutboxState = "queued" | "sending" | "awaiting_echo" | "failed";

export interface DurableOutboxItem {
  profileId: string;
  conversationId: string;
  otid: string;
  text: string;
  attachments: Attachment[];
  state: DurableOutboxState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DurableConversationSnapshot {
  messages: unknown[];
  nextBefore: string | null;
  forwardAfter: string | null;
  outbox: DurableOutboxItem[];
}

interface ConversationRow {
  next_before: string | null;
  forward_after: string | null;
}

interface MessageRow {
  raw_json: string;
}

interface OutboxRow {
  profile_id: string;
  conversation_id: string;
  otid: string;
  text: string;
  attachments_json: string;
  state: DurableOutboxState;
  error: string | null;
  created_at: number;
  updated_at: number;
}

let databasePromise: Promise<SQLiteDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function database(): Promise<SQLiteDatabase> {
  if (!databasePromise) databasePromise = openDatabase();
  return databasePromise;
}

async function openDatabase(): Promise<SQLiteDatabase> {
  const SQLite = await import("expo-sqlite");
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS durable_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_conversations (
      profile_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      next_before TEXT,
      forward_after TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS durable_messages (
      profile_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      otid TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (profile_id, conversation_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS durable_messages_sequence
      ON durable_messages(profile_id, conversation_id, sequence);
    CREATE INDEX IF NOT EXISTS durable_messages_otid
      ON durable_messages(profile_id, conversation_id, otid);
    CREATE TABLE IF NOT EXISTS durable_outbox (
      profile_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      otid TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, conversation_id, otid)
    );
  `);
  await db.runAsync(
    "INSERT OR REPLACE INTO durable_meta(key, value) VALUES ('schema_version', ?)",
    String(SCHEMA_VERSION),
  );
  return db;
}

function messageId(message: unknown, sequence: number): string {
  if (message && typeof message === "object") {
    const id = (message as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
    const otid = (message as { otid?: unknown }).otid;
    if (typeof otid === "string" && otid.length > 0) return `otid:${otid}`;
  }
  // Persisted server messages should always carry an id. Keep a deterministic
  // window-local fallback rather than dropping an unexpected protocol row.
  return `anonymous:${sequence}:${stableHash(JSON.stringify(message))}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseAttachments(raw: string): Attachment[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
}

function decodeOutbox(row: OutboxRow): DurableOutboxItem {
  return {
    profileId: row.profile_id,
    conversationId: row.conversation_id,
    otid: row.otid,
    text: row.text,
    attachments: parseAttachments(row.attachments_json),
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Load durable canonical history and locally-owned sends before touching the network. */
export async function loadDurableConversation(
  profileId: string,
  conversationId: string,
): Promise<DurableConversationSnapshot> {
  const db = await database();
  const [conversation, rows, outbox] = await Promise.all([
    db.getFirstAsync<ConversationRow>(
      "SELECT next_before, forward_after FROM durable_conversations WHERE profile_id = ? AND conversation_id = ?",
      profileId,
      conversationId,
    ),
    db.getAllAsync<MessageRow>(
      "SELECT raw_json FROM durable_messages WHERE profile_id = ? AND conversation_id = ? ORDER BY sequence ASC",
      profileId,
      conversationId,
    ),
    db.getAllAsync<OutboxRow>(
      "SELECT profile_id, conversation_id, otid, text, attachments_json, state, error, created_at, updated_at FROM durable_outbox WHERE profile_id = ? AND conversation_id = ? ORDER BY created_at ASC",
      profileId,
      conversationId,
    ),
  ]);
  const messages: unknown[] = [];
  for (const row of rows) {
    try {
      messages.push(JSON.parse(row.raw_json));
    } catch {
      // Corrupt cache rows are ignored; the next server sync repairs the window.
    }
  }
  return {
    messages,
    nextBefore: conversation?.next_before ?? null,
    forwardAfter: conversation?.forward_after ?? newestDurableMessageId(messages),
    outbox: outbox.map(decodeOutbox),
  };
}

/**
 * Persist the complete canonical window exactly in server order. Rewriting the
 * loaded window avoids timestamp/UUID ordering guesses for tightly-spaced tool
 * and reasoning messages while SQLite remains the durable source of truth.
 */
export async function saveDurableCanonicalWindow(
  profileId: string,
  conversationId: string,
  messages: readonly unknown[],
  cursors: { nextBefore: string | null; forwardAfter?: string | null },
  isCurrent?: () => boolean,
): Promise<void> {
  return serializeWrite(async () => {
    if (isCurrent && !isCurrent()) return;
    const db = await database();
    if (isCurrent && !isCurrent()) return;
    const forwardAfter = cursors.forwardAfter === undefined
      ? newestDurableMessageId(messages)
      : cursors.forwardAfter;
    const stale = Symbol("stale-durable-write");
    try {
      await db.withTransactionAsync(async () => {
        if (isCurrent && !isCurrent()) throw stale;
        await db.runAsync(
        `INSERT INTO durable_conversations(profile_id, conversation_id, next_before, forward_after, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, conversation_id) DO UPDATE SET
           next_before = excluded.next_before,
           forward_after = excluded.forward_after,
           updated_at = excluded.updated_at`,
        profileId,
        conversationId,
        cursors.nextBefore,
        forwardAfter,
        Date.now(),
      );
        if (isCurrent && !isCurrent()) throw stale;
        await db.runAsync(
        "DELETE FROM durable_messages WHERE profile_id = ? AND conversation_id = ?",
        profileId,
        conversationId,
      );
        for (let sequence = 0; sequence < messages.length; sequence += 1) {
          if (isCurrent && !isCurrent()) throw stale;
          const message = messages[sequence];
          await db.runAsync(
          `INSERT INTO durable_messages(profile_id, conversation_id, message_id, sequence, otid, raw_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          profileId,
          conversationId,
          messageId(message, sequence),
          sequence,
          durableMessageOtid(message),
          JSON.stringify(message),
          );
        }
      });
    } catch (error) {
      if (error !== stale) throw error;
    }
  });
}

export async function putDurableOutbox(item: DurableOutboxItem): Promise<void> {
  return serializeWrite(async () => {
    const db = await database();
    await db.runAsync(
      `INSERT INTO durable_outbox(profile_id, conversation_id, otid, text, attachments_json, state, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, conversation_id, otid) DO UPDATE SET
         text = excluded.text,
         attachments_json = excluded.attachments_json,
         state = excluded.state,
         error = excluded.error,
         updated_at = excluded.updated_at`,
      item.profileId,
      item.conversationId,
      item.otid,
      item.text,
      JSON.stringify(item.attachments),
      item.state,
      item.error,
      item.createdAt,
      item.updatedAt,
    );
  });
}

export async function updateDurableOutboxState(
  profileId: string,
  conversationId: string,
  otid: string,
  state: DurableOutboxState,
  error: string | null = null,
): Promise<void> {
  return serializeWrite(async () => {
    const db = await database();
    await db.runAsync(
      `UPDATE durable_outbox SET state = ?, error = ?, updated_at = ?
       WHERE profile_id = ? AND conversation_id = ? AND otid = ?`,
      state,
      error,
      Date.now(),
      profileId,
      conversationId,
      otid,
    );
  });
}

export async function removeDurableOutbox(
  profileId: string,
  conversationId: string,
  otid: string,
): Promise<void> {
  return serializeWrite(async () => {
    const db = await database();
    await db.runAsync(
      "DELETE FROM durable_outbox WHERE profile_id = ? AND conversation_id = ? AND otid = ?",
      profileId,
      conversationId,
      otid,
    );
  });
}

/** Persisted user echoes retire matching durable outbox rows by OTID. */
export async function retirePersistedOutboxEchoes(
  profileId: string,
  conversationId: string,
  messages: readonly unknown[],
): Promise<string[]> {
  const otids = persistedUserOtids(messages);
  if (otids.length === 0) return [];
  await serializeWrite(async () => {
    const db = await database();
    for (const otid of otids) {
      await db.runAsync(
        "DELETE FROM durable_outbox WHERE profile_id = ? AND conversation_id = ? AND otid = ?",
        profileId,
        conversationId,
        otid,
      );
    }
  });
  return otids;
}
