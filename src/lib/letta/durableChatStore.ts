import type { SQLiteDatabase } from "expo-sqlite";

import type { Attachment } from "./attachments";
const DB_NAME = "bloop-chat.db";
const SCHEMA_VERSION = 2;
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
  const schemaRow = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM durable_meta WHERE key = 'schema_version'",
  );
  const previousSchema = schemaRow ? Number.parseInt(schemaRow.value, 10) : 0;
  if (!Number.isFinite(previousSchema) || previousSchema < SCHEMA_VERSION) {
    // v1 mixed cached transcript history with delivery-journal state and could
    // manufacture stale/failed bubbles during reconnect. None of that state is
    // trustworthy enough to migrate. Server history is authoritative, so reset
    // the cache and legacy outbox once; future schemas can add narrower migrations.
    await db.withTransactionAsync(async () => {
      await db.runAsync("DROP TABLE IF EXISTS durable_messages");
      await db.runAsync("DROP TABLE IF EXISTS durable_conversations");
      await db.runAsync("DELETE FROM durable_outbox");
      await db.runAsync(
        "INSERT OR REPLACE INTO durable_meta(key, value) VALUES ('schema_version', ?)",
        String(SCHEMA_VERSION),
      );
    });
  } else {
    await db.runAsync(
      "INSERT OR REPLACE INTO durable_meta(key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  }
  return db;
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

/** Load only locally-owned delivery journal rows. Transcript history is never sourced from SQLite. */
export async function loadDurableOutbox(profileId: string, conversationId: string): Promise<DurableOutboxItem[]> {
  const db = await database();
  const rows = await db.getAllAsync<OutboxRow>(
    "SELECT profile_id, conversation_id, otid, text, attachments_json, state, error, created_at, updated_at FROM durable_outbox WHERE profile_id = ? AND conversation_id = ? ORDER BY created_at ASC",
    profileId,
    conversationId,
  );
  return rows.map(decodeOutbox);
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
