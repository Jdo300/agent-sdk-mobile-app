import { describe, expect, test } from "bun:test";
import { prepareSpeechText, speechMarkdownReady } from "./voiceSpeechText";

describe("voice speech markdown", () => {
  test("reads inline code while preserving surrounding prose", () => {
    expect(prepareSpeechText("Before `some_code()` and after the code."))
      .toBe("Before some_code() and after the code.");
  });

  test("keeps short inline settings and filenames understandable", () => {
    expect(prepareSpeechText("Set `speed` to `1.1` in `voice_gateway.py`."))
      .toBe("Set speed to 1.1 in voice_gateway.py.");
  });

  test("preserves prose after a fenced code block", () => {
    const markdown = "Before.\n```sh\necho hello\n```\nAfter the code block.";
    expect(prepareSpeechText(markdown)).toBe("Before. After the code block.");
  });

  test("does not consider an open fenced code block ready for streaming TTS", () => {
    expect(speechMarkdownReady("Before.\n```sh\necho hello")).toBe(false);
    expect(speechMarkdownReady("Before.\n```sh\necho hello\n```\nAfter.")).toBe(true);
  });
});
