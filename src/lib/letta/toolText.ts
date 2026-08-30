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

function basename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/$/, "");
  return clean.split("/").pop() || path;
}

function readableToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function commandIntent(command: string): string | null {
  // Tool projection runs on every live stream update. Bound inspection to a
  // short prefix so a generated multi-KB shell/script payload cannot turn the
  // friendly-label feature into work proportional to the full command size.
  const first = command.slice(0, 768).trim().split(/\n|&&|;/, 1)[0]?.trim() ?? "";
  if (!first) return null;
  if (/^(git\s+status|git\s+-[^ ]+\s+status)\b/i.test(first)) return "Check repository status";
  if (/^git\s+(diff|show|log)\b/i.test(first)) return "Inspect repository changes";
  if (/^git\s+(add|commit)\b/i.test(first)) return "Commit repository changes";
  if (/^git\s+push\b/i.test(first)) return "Push repository changes";
  if (/^(npm|bun|pnpm|yarn)\s+(test|run\s+test)\b/i.test(first)) return "Run tests";
  if (/^(npm|bun|pnpm|yarn)\s+(run\s+)?(lint|typecheck)\b/i.test(first)) return `Run ${/lint/i.test(first) ? "lint checks" : "type checks"}`;
  if (/^(cat|sed|head|tail|less)\s+/i.test(first)) {
    const match = first.match(/(?:^|\s)(\/[^\s'\"]+|\.\.?\/[^\s'\"]+|[^\s]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml|toml|sh))(?:\s|$)/i);
    return match ? `Read ${basename(match[1]!)}` : "Read file contents";
  }
  if (/^(grep|rg|ripgrep)\s+/i.test(first)) return "Search files";
  if (/^(curl|wget)\s+/i.test(first)) return "Request a web endpoint";
  if (/^(cp|rsync)\s+/i.test(first)) return "Copy files";
  if (/^mv\s+/i.test(first)) return "Move or rename files";
  if (/^rm\s+/i.test(first)) return "Remove files";
  if (/^(mkdir|install\s+-d)\s+/i.test(first)) return "Create a directory";
  if (/^(systemctl|service)\s+.*\b(restart|start|stop)\b/i.test(first)) return "Manage a system service";
  if (/^(docker|docker-compose|docker compose)\s+/i.test(first)) return "Manage a Docker service";
  if (/^(python|python3|node|bun)\s+/i.test(first)) return "Run a script";
  return null;
}

/**
 * Human-facing description of a tool call. The transcript should explain intent,
 * not lead with terminal syntax. Full arguments remain available in the detail
 * sheet, so this can deliberately favor readability over byte-for-byte fidelity.
 */
export function summarizeToolInput(input: unknown, toolName?: string): string {
  if (input == null) return toolName ? readableToolName(toolName) : "Tool call";
  if (typeof input === "string") {
    const commandSummary = toolName?.toLowerCase().includes("bash") || toolName?.toLowerCase().includes("shell")
      ? commandIntent(input)
      : null;
    return commandSummary ?? input.slice(0, 120);
  }
  const record = input as Record<string, unknown>;

  // Letta/Code tools commonly provide a description alongside the low-level
  // command. That description is the best transcript label and should outrank
  // command/path fields.
  for (const key of ["description", "summary", "purpose", "intent"]) {
    if (typeof record[key] === "string" && (record[key] as string).trim()) {
      return (record[key] as string).trim();
    }
  }

  // Edit-shaped inputs earn a concise path/change summary when no description
  // was supplied by the tool.
  if (typeof record.old_string === "string" && typeof record.new_string === "string") {
    const path =
      typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : "";
    const removed = record.old_string ? record.old_string.split("\n").length : 0;
    const added = record.new_string ? record.new_string.split("\n").length : 0;
    return `${path ? `Edit ${basename(path)} ` : "Edit file "}+${added} −${removed}`;
  }

  if (typeof record.command === "string") {
    const intent = commandIntent(record.command);
    if (intent) return intent;
  }

  const lowerName = toolName?.toLowerCase() ?? "";
  const path = typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : null;
  if (path && /(read|view|open|get)/.test(lowerName)) return `Read ${basename(path)}`;
  if (path && /(write|edit|patch|update)/.test(lowerName)) return `Update ${basename(path)}`;
  if (typeof record.query === "string") return `Search for “${record.query.slice(0, 80)}”`;
  if (typeof record.url === "string") return `Open ${record.url.slice(0, 100)}`;
  if (path) return `${readableToolName(toolName ?? "Access")} ${basename(path)}`;

  // Last resort: prefer a readable tool label over dumping raw JSON into the
  // collapsed transcript. The complete JSON is still one tap away.
  return toolName ? readableToolName(toolName) : "Tool call";
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
