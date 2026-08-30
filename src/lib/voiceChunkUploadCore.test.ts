import { describe, expect, test } from "bun:test";
import {
  VOICE_LIVE_SAFETY_TAIL_BYTES,
  VOICE_MAX_CHUNK_BYTES,
  nextVoiceChunkRange,
  stableVoiceUploadTarget,
} from "./voiceChunkUploadCore";

describe("voice background upload planning", () => {
  test("leaves a safety tail while the native recorder is still writing", () => {
    expect(stableVoiceUploadTarget(VOICE_LIVE_SAFETY_TAIL_BYTES - 1, false)).toBe(0);
    expect(stableVoiceUploadTarget(VOICE_LIVE_SAFETY_TAIL_BYTES + 1234, false)).toBe(1234);
  });

  test("flushes the entire completed recording", () => {
    expect(stableVoiceUploadTarget(4_321_000, true)).toBe(4_321_000);
  });

  test("caps each network write and advances without overlap", () => {
    expect(nextVoiceChunkRange(0, VOICE_MAX_CHUNK_BYTES + 500)).toEqual({
      offset: 0,
      length: VOICE_MAX_CHUNK_BYTES,
    });
    expect(nextVoiceChunkRange(VOICE_MAX_CHUNK_BYTES, VOICE_MAX_CHUNK_BYTES + 500)).toEqual({
      offset: VOICE_MAX_CHUNK_BYTES,
      length: 500,
    });
    expect(nextVoiceChunkRange(1500, 1500)).toBeNull();
  });
});
