/**
 * Image + audio attachments for the composer.
 *
 * Images are downscaled and re-encoded at intake (as remodex does) rather than
 * at send: a modern phone photo is ~4000px of base64 that would bloat every
 * turn's context for no visual gain on a phone-sized transcript.
 *
 * Audio is different: the Letta Agent SDK only accepts text+image content parts
 * in a user message, so a picked recording is NOT sent into the chat as an
 * attachment. Instead it is uploaded to the voice gateway (Whisper) and the
 * resulting transcript is sent as a normal text message. The original audio is
 * kept on rgserver (voice-gateway/uploads) so it can be attached to whatever we
 * file the transcript into (e.g. a Nextcloud note).
 */
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";

import type { ImageContent } from "@letta-ai/letta-agent-sdk/client";

/** Longest edge kept after downscaling; matches the references' ~1600px. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

export interface Attachment {
  id: string;
  /** Local uri for the thumbnail. */
  uri: string;
  /** Base64 payload, ready for the SDK's multimodal content array. */
  data: string;
  mediaType: ImageContent["source"]["media_type"];
  width: number;
  height: number;
}

/** Ask for library access and let the user pick images. Empty when cancelled or denied. */
export async function pickImages(): Promise<Attachment[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return [];
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: 4,
    quality: 1,
  });
  if (result.canceled) return [];
  const prepared = await Promise.all(result.assets.map((asset, index) => prepare(asset, index)));
  return prepared.filter((a): a is Attachment => a !== null);
}

async function prepare(
  asset: ImagePicker.ImagePickerAsset,
  index: number,
): Promise<Attachment | null> {
  try {
    const longest = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
    const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
    if (scale < 1) {
      context.resize({
        width: Math.round((asset.width ?? MAX_EDGE) * scale),
        height: Math.round((asset.height ?? MAX_EDGE) * scale),
      });
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      format: ImageManipulator.SaveFormat.JPEG,
      compress: JPEG_QUALITY,
      base64: true,
    });
    if (!saved.base64) return null;
    return {
      id: `att-${Date.now()}-${index}`,
      uri: saved.uri,
      data: saved.base64,
      // Re-encoded above, so the type is known regardless of the source format.
      mediaType: "image/jpeg",
      width: saved.width,
      height: saved.height,
    };
  } catch {
    return null;
  }
}

/** Attachments as SDK image content parts. */
export function toImageContent(attachments: Attachment[]): ImageContent[] {
  return attachments.map((a) => ({
    type: "image",
    source: { type: "base64", media_type: a.mediaType, data: a.data },
  }));
}

/**
 * An audio picked from the iOS Recordings / Voice Memos / Files app.
 * See the module header for why this is not a message content part.
 */
export interface AudioAttachment {
  id: string;
  /** Local uri (cache copy) of the picked audio file. */
  uri: string;
  /** Original file name (e.g. "My Recording.m4a"). */
  name: string;
  /** MIME type when the picker reported one (e.g. audio/x-m4a). */
  mediaType: string | null;
  /** File size in bytes, if known. */
  size: number | null;
  /** Last-modified epoch ms, if known. */
  lastModified: number | null;
}

/**
 * Open the system file picker for audio (and video, since phone recordings can
 * be .m4a/.mov) and return the picked files. Empty when cancelled or denied.
 *
 * Uses expo-document-picker so it reaches the iOS Recordings app / Voice Memos /
 * Files -> On My iPhone, which expo-image-picker (images/videos only) cannot.
 */
export async function pickAudio(): Promise<AudioAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["audio/*", "video/*"],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  const out: AudioAttachment[] = [];
  result.assets.forEach((a, index) => {
    out.push({
      id: `aud-${Date.now()}-${index}`,
      uri: a.uri,
      name: a.name,
      mediaType: a.mimeType ?? null,
      size: a.size ?? null,
      lastModified: a.lastModified ?? null,
    });
  });
  return out;
}
