/**
 * Reduce assistant markdown to text that is actually useful to hear aloud.
 * A turn containing only code, images, embeds, or bare URLs should not produce
 * a voice-reply card at all.
 */

/**
 * Streaming assistant text is not safe to hand to TTS while a Markdown code
 * fence is still open. During that window the prose after the code block has
 * not necessarily arrived yet, and the Markdown scrubber cannot reliably
 * distinguish code from narration.
 */
export function speechMarkdownReady(markdown: string): boolean {
  const fences = markdown.match(/```|~~~/g) ?? [];
  let backtickOpen = false;
  let tildeOpen = false;
  for (const fence of fences) {
    if (fence === "```") backtickOpen = !backtickOpen;
    else tildeOpen = !tildeOpen;
  }
  return !backtickOpen && !tildeOpen;
}

export function prepareSpeechText(markdown: string): string {
  const inlineCode: string[] = [];
  const protectedMarkdown = markdown
    // Code is visual reference material, not prose. Strip fenced blocks first
    // so their backticks cannot be mistaken for inline code below.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Inline code often carries the exact noun, command, setting, or filename
    // that makes the surrounding sentence understandable. Protect its contents
    // while Markdown emphasis is scrubbed, then restore it verbatim.
    .replace(/`([^`\n]*)`/g, (_match, code: string) => {
      const index = inlineCode.push(code) - 1;
      return `\uE000${index}\uE001`;
    });

  return protectedMarkdown
    // Images should not create a voice card by themselves. Ordinary links keep
    // their human-readable label but discard the URL.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // HTML-ish embeds/tags and standalone URLs are non-speakable chrome.
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    // Remove common Markdown structure while preserving the words.
    .replace(/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/gm, " ")
    .replace(/[*_~]+/g, "")
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => inlineCode[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

