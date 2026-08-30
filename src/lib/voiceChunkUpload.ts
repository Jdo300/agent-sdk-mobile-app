import { File } from "expo-file-system";

import { nextVoiceChunkRange, stableVoiceUploadTarget } from "./voiceChunkUploadCore";
import { voiceHttpBaseUrl } from "./voiceTransport";

const HEADER_PATCH_BYTES = 256 * 1024;

export type VoiceChunkUploadSession = {
  uploadId: string;
  offset: number;
};

function request(
  method: string,
  url: string,
  token: string,
  headers: Record<string, string> = {},
  body?: ArrayBuffer,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.onerror = () => reject(new Error("Voice background upload failed."));
    xhr.ontimeout = () => reject(new Error("Voice background upload timed out."));
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText ?? "" });
    xhr.send(body ?? null);
  });
}

export async function createVoiceChunkUpload(
  token: string,
  serverUrl: string,
): Promise<VoiceChunkUploadSession> {
  const response = await request("POST", `${voiceHttpBaseUrl(serverUrl)}/voice/upload/start`, token);
  if (response.status !== 201) throw new Error(`Voice background upload could not start (${response.status}).`);
  const payload = JSON.parse(response.text) as { upload_id?: string };
  if (!payload.upload_id) throw new Error("Voice background upload did not return an upload ID.");
  return { uploadId: payload.upload_id, offset: 0 };
}

function fileRange(uri: string, offset: number, length: number): ArrayBuffer {
  const file = new File(uri);
  const handle = file.open();
  try {
    handle.offset = offset;
    const bytes = handle.readBytes(length);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } finally {
    handle.close();
  }
}

async function uploadRange(
  session: VoiceChunkUploadSession,
  uri: string,
  token: string,
  serverUrl: string,
  offset: number,
  length: number,
): Promise<void> {
  if (length <= 0) return;
  const body = fileRange(uri, offset, length);
  const response = await request(
    "POST",
    `${voiceHttpBaseUrl(serverUrl)}/voice/upload/${encodeURIComponent(session.uploadId)}/chunk`,
    token,
    {
      "Content-Type": "application/octet-stream",
      "X-Upload-Offset": String(offset),
    },
    body,
  );
  if (response.status !== 200) throw new Error(`Voice background chunk upload failed (${response.status}).`);
}

/**
 * Upload all stable bytes currently available. While recording we deliberately
 * leave a small tail local so we never race AVAudioRecorder while it is
 * extending the m4a container. The final flush sends that tail after stop().
 */
export async function pumpVoiceChunkUpload(
  session: VoiceChunkUploadSession,
  uri: string,
  token: string,
  serverUrl: string,
  final = false,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<void> {
  const file = new File(uri);
  const total = file.size;
  const target = stableVoiceUploadTarget(total, final);
  while (session.offset < target) {
    const range = nextVoiceChunkRange(session.offset, target);
    if (!range) break;
    await uploadRange(session, uri, token, serverUrl, range.offset, range.length);
    session.offset += range.length;
    onProgress?.(session.offset, total);
  }
}

/** Re-send the container header after AVAudioRecorder closes and patches it. */
export async function patchVoiceChunkHeader(
  session: VoiceChunkUploadSession,
  uri: string,
  token: string,
  serverUrl: string,
): Promise<void> {
  const size = new File(uri).size;
  const length = Math.min(size, HEADER_PATCH_BYTES);
  if (length > 0) await uploadRange(session, uri, token, serverUrl, 0, length);
}

export function completedVoiceFile(uri: string): { size: number; md5: string | null } {
  const file = new File(uri);
  return { size: file.size, md5: file.md5 };
}

export async function finalizeVoiceChunkUpload(
  session: VoiceChunkUploadSession,
  token: string,
  serverUrl: string,
  metadata: { durationSeconds: number; finalSize: number; md5: string | null },
): Promise<{ status: number; text: string }> {
  return request(
    "POST",
    `${voiceHttpBaseUrl(serverUrl)}/voice/upload/${encodeURIComponent(session.uploadId)}/finalize`,
    token,
    {
      "X-Upload-Final-Size": String(metadata.finalSize),
      "X-Audio-Duration-Seconds": String(metadata.durationSeconds),
      ...(metadata.md5 ? { "X-Upload-MD5": metadata.md5 } : {}),
      "X-Audio-Filename": "milo-voice.m4a",
      "X-Audio-Content-Type": "audio/mp4",
    },
  );
}
