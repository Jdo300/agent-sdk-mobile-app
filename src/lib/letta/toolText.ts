/**
 * Text shaping shared by the transcript projection and the SDK bridge: wire
 * content arrives as strings, JSON-encoded arrays, or content-part objects, and
 * user messages carry system-reminder wrappers no one should read.
 */

export /** Strip harness wrappers (system reminders) from user-visible message text. */
function cleanUserText(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function contentToText(content: unknown): string {
  // History user messages sometimes arrive as a JSON-encoded content array.
  if (typeof content === "string" && content.startsWith("[")) {
    try {
      return contentToText(JSON.parse(content));
    } catch {
      return content;
    }
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? "")))
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

export function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 120);
  const record = input as Record<string, unknown>;
  // Edit-shaped inputs earn a change-size stat next to the path — the one
  // number that matters when supervising edits from a card.
  if (typeof record.old_string === "string" && typeof record.new_string === "string") {
    const path =
      typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : "";
    const removed = record.old_string ? record.old_string.split("\n").length : 0;
    const added = record.new_string ? record.new_string.split("\n").length : 0;
    return `${path ? `${path} ` : ""}+${added} −${removed}`;
  }
  const preferred = ["command", "path", "file_path", "query", "url", "description"];
  for (const key of preferred) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  try {
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return "";
  }
}

export /** Full payload for the detail sheet — pretty JSON, JSON-encoded strings unwrapped. */
function formatToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return undefined;
  }
}
