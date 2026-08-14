/**
 * Image attachments for the composer.
 *
 * Downscaled and re-encoded at intake (as remodex does) rather than at send:
 * a modern phone photo is ~4000px of base64 that would bloat every turn's
 * context for no visual gain on a phone-sized transcript.
 */
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

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
