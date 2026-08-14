/**
 * Line-level diff vocabulary for tool payloads (docs/design-doc.md §4.4/4.5).
 * Line classification is ported from litter's DiffRendering — a line-level
 * treatment is enough for supervising edits on a phone; no word-level diffing.
 */

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

// File headers and git metadata must be checked before the bare +/- prefixes:
// "+++ b/file" is metadata, not an addition.
const META_PREFIXES = [
  "+++ ",
  "--- ",
  "diff --git ",
  "index ",
  "new file mode ",
  "deleted file mode ",
  "rename from ",
  "rename to ",
  "similarity index ",
  "Binary files ",
];

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Unified-diff-shaped: a hunk header, or a `---`/`+++` file header pair. */
export function isUnifiedDiff(text: string): boolean {
  return (
    /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text) ||
    (/^--- /m.test(text) && /^\+\+\+ /m.test(text))
  );
}

/**
 * Naive removed/added line diff for Edit-style `{old_string, new_string}`
 * inputs — the payload carries no line anchors, so old-block-then-new-block
 * is the most honest rendering available.
 */
export function diffFromEditInput(inputText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.old_string !== "string" || typeof record.new_string !== "string") return null;
  const path =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : null;
  const removed = record.old_string ? record.old_string.split("\n").map((l) => `-${l}`) : [];
  const added = record.new_string ? record.new_string.split("\n").map((l) => `+${l}`) : [];
  return [...(path ? [`--- ${path}`, `+++ ${path}`] : []), ...removed, ...added].join("\n");
}
