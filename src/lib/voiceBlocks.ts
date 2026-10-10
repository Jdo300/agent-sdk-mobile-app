/**
 * Voice-block split for expressive TTS (issue #33).
 *
 * Agents may embed `<voice>...</voice>` blocks in a single reply stream.
 * The block content is the spoken script (may rephrase the written message
 * and carries Chatterbox paralinguistic tags like [chuckle]); the text
 * outside the blocks is the chat display. The split is explicit — no
 * bracket-guessing regex ever strips legitimate content.
 *
 * Rules (issue #33 contract):
 * - Chat UI removes whole blocks, content included.
 * - TTS speaks only block content, raw, tags intact.
 * - No block at all -> caller falls back to speaking the whole message
 *   (speech === null signals the fallback).
 * - Unclosed block at end of stream -> remainder counts as voice.
 * - Multiple blocks concatenate in order for TTS.
 */

export interface VoiceSplit {
  /** Text for the chat UI, with voice blocks removed. */
  display: string;
  /** Concatenated spoken content of all blocks, or null when the message
   *  contains no voice blocks at all (caller then speaks the whole message). */
  speech: string | null;
}

const OPEN = "<voice>";
const CLOSE = "</voice>";

function collect(text: string): VoiceSplit {
  const spoken: string[] = [];
  let display = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(OPEN, cursor);
    if (open === -1) {
      display += text.slice(cursor);
      break;
    }
    display += text.slice(cursor, open);
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      // Unclosed at end of stream: the remainder is voice content.
      spoken.push(text.slice(open + OPEN.length));
      cursor = text.length;
      break;
    }
    spoken.push(text.slice(open + OPEN.length, close));
    cursor = close + CLOSE.length;
  }
  const speech = spoken.map((part) => part.trim()).filter((part) => part.length > 0).join(" ");
  // Removing a leading block can leave a stray leading blank line behind.
  return { display: display.replace(/^\n+/, "").replace(/\s+$/, ""), speech: speech.length > 0 ? speech : null };
}

/** Final (settled) message text. */
export function splitVoiceBlocks(text: string): VoiceSplit {
  return collect(text);
}

/**
 * Streaming partial text. A trailing fragment that could still become an
 * opening <voice> tag ("<", "<v", "<vo", "<voi", "<voic") is suppressed from
 * the display so the tag never flashes on screen mid-chunk. A block that has
 * opened but not closed already suppresses its content via collect().
 */
export function splitVoiceBlocksStreaming(text: string): VoiceSplit {
  // Only trim a trailing tag fragment when no block is currently open;
  // otherwise the tail is block content (possibly an incomplete closing tag)
  // and collect() already keeps it out of the display.
  const lastOpen = text.lastIndexOf(OPEN);
  const blockIsOpen = lastOpen !== -1 && text.indexOf(CLOSE, lastOpen + OPEN.length) === -1;
  if (!blockIsOpen) {
    const maxFragment = Math.min(text.length, OPEN.length - 1);
    for (let k = maxFragment; k >= 1; k--) {
      if (text.endsWith(OPEN.slice(0, k))) {
        return collect(text.slice(0, text.length - k));
      }
    }
  }
  return collect(text);
}
