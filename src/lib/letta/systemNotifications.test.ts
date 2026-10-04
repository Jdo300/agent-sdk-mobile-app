import { describe, expect, test } from "bun:test";

import {
  mergeNotificationsChronologically,
  projectTaskNotifications,
  taskNotificationFromMessage,
} from "./systemNotifications";
import type { TranscriptItem } from "./model";

describe("system task notifications", () => {
  test("projects a task result into compact card data", () => {
    const item = taskNotificationFromMessage({
      id: "system-1",
      message_type: "system_message",
      date: "2026-10-04T12:00:00.000Z",
      content: "Task result: Nightly sync\nStatus: completed\n42 files synchronized successfully.",
    });

    expect(item).toEqual({
      kind: "notification",
      id: "notification-system-1",
      title: "Nightly sync",
      summary: "42 files synchronized successfully.",
      raw: "Task result: Nightly sync\nStatus: completed\n42 files synchronized successfully.",
      status: "completed",
      occurredAt: Date.parse("2026-10-04T12:00:00.000Z"),
    });
  });

  test("keeps ordinary system prompts out of the transcript", () => {
    expect(taskNotificationFromMessage({
      id: "system-prompt",
      message_type: "system_message",
      content: "You are Milo, an engineering assistant. Follow the system instructions.",
      date: "2026-10-04T12:00:00.000Z",
    })).toBeNull();
  });

  test("recognizes reminder notifications", () => {
    const [item] = projectTaskNotifications([{
      id: "reminder-1",
      message_type: "system_message",
      content: "REMINDER: Review the overnight benchmark results.",
      date: "2026-10-04T13:00:00.000Z",
    }]);
    expect(item?.title).toBe("Review the overnight benchmark results.");
  });

  test("merges notifications between persisted rows by server time", () => {
    const transcript: TranscriptItem[] = [
      { kind: "user", id: "u1", text: "start", occurredAt: 100 },
      { kind: "assistant", id: "a1", text: "done", occurredAt: 300 },
    ];
    const notification = {
      kind: "notification" as const,
      id: "notification-n1",
      title: "Task complete",
      summary: "Finished",
      raw: "Task result: Finished",
      occurredAt: 200,
    };
    expect(mergeNotificationsChronologically(transcript, [notification]).map((row) => row.id)).toEqual([
      "u1",
      "notification-n1",
      "a1",
    ]);
  });
});
