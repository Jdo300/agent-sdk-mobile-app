import { expect, test } from "bun:test";

import { splitVoiceBlocks, splitVoiceBlocksStreaming } from "./voiceBlocks";

test("no blocks: display unchanged, speech null (fallback to whole message)", () => {
  const r = splitVoiceBlocks("Hello there, how is the project going?");
  expect(r.display).toBe("Hello there, how is the project going?");
  expect(r.speech).toBeNull();
});

test("leading voice block: stripped from display, content for TTS", () => {
  const r = splitVoiceBlocks("<voice>Nice [chuckle], that worked.</voice>\nNice, that worked on the first try.");
  expect(r.display).toBe("Nice, that worked on the first try.");
  expect(r.speech).toBe("Nice [chuckle], that worked.");
});

test("block in the middle and end", () => {
  const r = splitVoiceBlocks("Before <voice>spoken middle</voice> after <voice>spoken end</voice>");
  expect(r.display).toBe("Before  after");
  expect(r.speech).toBe("spoken middle spoken end");
});

test("unclosed block at end of stream counts as voice", () => {
  const r = splitVoiceBlocks("Display text. <voice>spoken but never closed");
  expect(r.display).toBe("Display text.");
  expect(r.speech).toBe("spoken but never closed");
});

test("empty block yields no speech", () => {
  const r = splitVoiceBlocks("Only display. <voice>   </voice>");
  expect(r.display).toBe("Only display.");
  expect(r.speech).toBeNull();
});

test("markdown links and brackets are never touched", () => {
  const r = splitVoiceBlocks("See [the docs](https://example.com) and the [chuckle] note.");
  expect(r.display).toBe("See [the docs](https://example.com) and the [chuckle] note.");
  expect(r.speech).toBeNull();
});

test("streaming: partial opening tag at chunk end is suppressed", () => {
  for (const fragment of ["<", "<v", "<vo", "<voi", "<voic"]) {
    const r = splitVoiceBlocksStreaming("Hello wor" + fragment);
    expect(r.display).toBe("Hello wor");
    expect(r.speech).toBeNull();
  }
});

test("streaming: opened-but-unclosed block hides content from display", () => {
  const r = splitVoiceBlocksStreaming("Chat text. <voice>spoken part still arriving");
  expect(r.display).toBe("Chat text.");
  expect(r.speech).toBe("spoken part still arriving");
});

test("streaming: incomplete closing tag keeps content out of display", () => {
  const r = splitVoiceBlocksStreaming("<voice>spoken text</voi");
  expect(r.display).toBe("");
  expect(r.speech).toBe("spoken text</voi");
});

test("streaming: a tag that cannot be a voice tag prefix stays visible", () => {
  // "<b" is not a prefix of <voice>, so nothing is suppressed.
  const r = splitVoiceBlocksStreaming("a <b>bold</b>");
  expect(r.display).toBe("a <b>bold</b>");
});

test("speech concatenates multiple blocks in order", () => {
  const r = splitVoiceBlocks("<voice>one</voice>mid<voice>two</voice>");
  expect(r.display).toBe("mid");
  expect(r.speech).toBe("one two");
});
