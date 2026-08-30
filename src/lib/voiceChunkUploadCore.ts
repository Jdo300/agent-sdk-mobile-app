export const VOICE_LIVE_SAFETY_TAIL_BYTES = 64 * 1024;
export const VOICE_MAX_CHUNK_BYTES = 128 * 1024;

export function stableVoiceUploadTarget(fileSize: number, final: boolean): number {
  const size = Math.max(0, Math.floor(fileSize));
  return final ? size : Math.max(0, size - VOICE_LIVE_SAFETY_TAIL_BYTES);
}

export function nextVoiceChunkRange(offset: number, target: number): { offset: number; length: number } | null {
  const start = Math.max(0, Math.floor(offset));
  const end = Math.max(0, Math.floor(target));
  if (start >= end) return null;
  return { offset: start, length: Math.min(VOICE_MAX_CHUNK_BYTES, end - start) };
}
