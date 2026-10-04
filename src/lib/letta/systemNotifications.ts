import type { NotificationItem, TranscriptItem } from "./model";

const TASK_NOTIFICATION_MARKER =
  /(?:<\/?(?:task[_ -]?notification|background[_ -]?task|system[_ -]?notification)\b|\btask\s+(?:notification|result|completed|failed)\b|\bbackground\s+task\b|\bscheduled\s+task\b|^\s*reminder\s*:)/i;

const STATUS_PATTERN = /\b(completed|complete|succeeded|success|failed|error|cancelled|canceled|running|pending)\b/i;

function cleanLine(value: string): string {
  return value
    .replace(/<\/?[A-Za-z0-9_-]+(?:\s[^>]*)?>/g, " ")
    .replace(/^[#>*\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, max = 180): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function titleFromContent(content: string): string {
  const lines = content.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const first = lines[0] ?? "Task notification";
  const stripped = first
    .replace(/^(?:task\s+(?:notification|result)|background\s+task|scheduled\s+task|system\s+notification|reminder)\s*[:\-–—]?\s*/i, "")
    .trim();
  if (!stripped || stripped.length < 3) return "Task notification";
  return clip(stripped, 80);
}

function summaryFromContent(content: string, title: string): string {
  const lines = content.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const candidate =
    lines.slice(1).find((line) => !/^status\s*:/i.test(line)) ??
    lines.find((line) => line !== title && !/^status\s*:/i.test(line)) ??
    lines[0] ??
    content;
  return clip(candidate);
}

export function taskNotificationFromMessage(raw: unknown, index = 0): NotificationItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.message_type !== "system_message" || typeof record.content !== "string") return null;

  const content = record.content.trim();
  if (!content || !TASK_NOTIFICATION_MARKER.test(content)) return null;

  const title = titleFromContent(content);
  const statusMatch = STATUS_PATTERN.exec(content);
  const status = statusMatch?.[1]?.toLowerCase().replace("canceled", "cancelled") ?? null;
  const date = typeof record.date === "string" ? Date.parse(record.date) : Number.NaN;
  const identity =
    (typeof record.id === "string" && record.id) ||
    (typeof record.otid === "string" && record.otid) ||
    `${Number.isFinite(date) ? date : "undated"}-${index}`;

  return {
    kind: "notification",
    id: `notification-${identity}`,
    title,
    summary: summaryFromContent(content, title),
    raw: content,
    ...(status ? { status } : {}),
    ...(Number.isFinite(date) ? { occurredAt: date } : {}),
  };
}

export function projectTaskNotifications(messages: readonly unknown[]): NotificationItem[] {
  const notifications: NotificationItem[] = [];
  messages.forEach((message, index) => {
    const notification = taskNotificationFromMessage(message, index);
    if (notification) notifications.push(notification);
  });
  return notifications;
}

export function mergeNotificationsChronologically(
  transcript: readonly TranscriptItem[],
  notifications: readonly NotificationItem[],
): TranscriptItem[] {
  if (notifications.length === 0) return [...transcript];
  const rows = [...transcript];

  for (const notification of notifications) {
    if (rows.some((row) => row.id === notification.id)) continue;
    const at = notification.occurredAt;
    if (at === undefined) {
      rows.push(notification);
      continue;
    }
    const index = rows.findIndex((row) => row.occurredAt !== undefined && row.occurredAt > at);
    if (index < 0) rows.push(notification);
    else rows.splice(index, 0, notification);
  }
  return rows;
}
