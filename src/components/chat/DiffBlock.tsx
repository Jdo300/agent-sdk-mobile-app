/**
 * Line-classified diff text — additions/deletions in the palette's run/danger
 * tones, metadata quiet (docs/design-doc.md §2 tones; coloring ported from
 * litter's CodeBlockView diff treatment).
 */
import { diffLineKind } from "../../lib/diff";
import { Text } from "../ui/Text";

export function DiffBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Text role="sub" mono selectable>
      {lines.map((line, index) => {
        const kind = diffLineKind(line);
        return (
          <Text
            key={index}
            role="sub"
            mono
            tone={kind === "add" ? "run" : kind === "del" ? "danger" : undefined}
            ink={kind === "meta" || kind === "hunk" ? 3 : 2}
          >
            {index < lines.length - 1 ? `${line}\n` : line}
          </Text>
        );
      })}
    </Text>
  );
}
