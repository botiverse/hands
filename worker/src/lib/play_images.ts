/**
 * Google Play store listing images (androidpublisher v3 edits.images).
 *
 * imageType is Google's full enum (discovery revision 20261027), never narrowed:
 * a value Google defines but Hands does not implement is rejected as
 * "not supported yet", not as invalid.
 *
 * Constraints, all enforced before a Play edit is opened:
 * - Every upload: at most 15,728,640 bytes (edits.images.upload mediaUpload.maxSize,
 *   discovery), `accept: image/*`; Hands sends PNG or JPEG only.
 * - Screenshots (phone, 7-inch, 10-inch, TV): "JPEG or 24-bit PNG (no alpha)",
 *   minimum dimension 320px, maximum 3840px, the longer side at most twice the
 *   shorter; "up to 8 screenshots for each supported device type"
 *   (Play Console Help answer/9866151 "Add preview assets").
 * - Wear OS screenshots: 1:1 aspect ratio, at least 384x384 (same page).
 * - Feature graphic: JPEG or 24-bit PNG (no alpha), exactly 1024x500 (same page).
 * - App icon: 32-bit PNG (with alpha), exactly 512x512, at most 1024 KB (same page).
 * - TV banner: JPEG or 24-bit PNG (no alpha), exactly 1280x720 (same page).
 * - Phone screenshots: at least 2 per language (Play Console requires two to
 *   publish; Hands applies it per phone set so a push cannot leave a language
 *   with one). Other screenshot types: 1-8. Single-image types: exactly 1.
 */

export const PLAY_IMAGE_TYPES = [
  "appImageTypeUnspecified",
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
] as const;
export type PlayImageType = typeof PLAY_IMAGE_TYPES[number];

/** edits.images.upload `aiGeneratedState` enum (discovery revision 20261027). */
export const PLAY_AI_GENERATED_STATES = [
  "aiGeneratedStateUnspecified",
  "aiGeneratedStateNotAiGenerated",
  "aiGeneratedStateAiGeneratedDeveloperAttested",
] as const;
export type PlayAiGeneratedState = typeof PLAY_AI_GENERATED_STATES[number];

export const PLAY_IMAGE_MAX_BYTES = 15_728_640;

type ImageSpec = {
  min: number;
  max: number;
  formats: Array<"png-no-alpha" | "png-alpha" | "jpeg">;
  exact?: { width: number; height: number };
  maxBytes?: number;
  screenshot?: { minSide: number; maxSide: number; maxRatio: number };
  square?: { minSide: number };
};

const SCREENSHOT: ImageSpec = {
  min: 1, max: 8, formats: ["png-no-alpha", "jpeg"],
  screenshot: { minSide: 320, maxSide: 3840, maxRatio: 2 },
};

/** Types Hands implements. appImageTypeUnspecified ("Do not use") is not one of them. */
export const PLAY_IMAGE_SPECS: Partial<Record<PlayImageType, ImageSpec>> = {
  phoneScreenshots: { ...SCREENSHOT, min: 2 },
  sevenInchScreenshots: SCREENSHOT,
  tenInchScreenshots: SCREENSHOT,
  tvScreenshots: SCREENSHOT,
  wearScreenshots: { min: 1, max: 8, formats: ["png-no-alpha", "jpeg"], square: { minSide: 384 } },
  featureGraphic: { min: 1, max: 1, formats: ["png-no-alpha", "jpeg"], exact: { width: 1024, height: 500 } },
  icon: { min: 1, max: 1, formats: ["png-alpha"], exact: { width: 512, height: 512 }, maxBytes: 1024 * 1024 },
  tvBanner: { min: 1, max: 1, formats: ["png-no-alpha", "jpeg"], exact: { width: 1280, height: 720 } },
};

export interface SniffedImage {
  format: "png" | "jpeg";
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** PNG only: colour type 4/6, or a tRNS chunk before IDAT. */
  alpha: boolean;
  /** PNG only: 8-bit RGB (24-bit) or 8-bit RGBA (32-bit). */
  pngDepth: 24 | 32 | null;
}

export class PlayImageError extends Error {
  constructor(readonly failureCode: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read format and pixel size from the header bytes. Returns null for anything else. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 33 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    const width = u32(bytes, 16);
    const height = u32(bytes, 20);
    const bitDepth = bytes[24]!;
    const colorType = bytes[25]!;
    let alpha = colorType === 4 || colorType === 6;
    // Walk chunks up to IDAT: a tRNS chunk makes an RGB/palette PNG transparent.
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = u32(bytes, offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === "IDAT" || type === "IEND") break;
      if (type === "tRNS") alpha = true;
      offset += 12 + length;
    }
    const pngDepth = bitDepth === 8 && colorType === 2 ? 24 : bitDepth === 8 && colorType === 6 ? 32 : null;
    return { format: "png", contentType: "image/png", width, height, alpha, pngDepth };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
      // SOF0-SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (offset + 9 > bytes.length) return null;
        const height = (bytes[offset + 5]! << 8) + bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) + bytes[offset + 8]!;
        return { format: "jpeg", contentType: "image/jpeg", width, height, alpha: false, pngDepth: null };
      }
      if (marker === 0xda || length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

export function isPlayImageType(value: unknown): value is PlayImageType {
  return typeof value === "string" && (PLAY_IMAGE_TYPES as readonly string[]).includes(value);
}

/** Validate one image against its type's documented constraints. */
export function checkImage(imageType: PlayImageType, bytes: Uint8Array, label: string): SniffedImage {
  const spec = PLAY_IMAGE_SPECS[imageType];
  if (!spec) throw new PlayImageError("image_type_not_supported", `imageType ${imageType} is not supported yet`, { imageType });
  if (bytes.byteLength > PLAY_IMAGE_MAX_BYTES) {
    throw new PlayImageError("image_too_large", `${label} is ${bytes.byteLength} bytes; Google Play accepts at most ${PLAY_IMAGE_MAX_BYTES}`);
  }
  if (spec.maxBytes && bytes.byteLength > spec.maxBytes) {
    throw new PlayImageError("image_too_large", `${label} is ${bytes.byteLength} bytes; a Play ${imageType} is at most ${spec.maxBytes}`);
  }
  const image = sniffImage(bytes);
  if (!image || image.width === 0 || image.height === 0) {
    throw new PlayImageError("image_format_unsupported", `${label} is not a PNG or JPEG image`);
  }
  const kind = image.format === "jpeg" ? "jpeg" : image.alpha ? "png-alpha" : "png-no-alpha";
  const formatOk = spec.formats.includes(kind)
    && (kind === "png-no-alpha" ? image.pngDepth === 24 : kind === "png-alpha" ? image.pngDepth === 32 : true);
  if (!formatOk) {
    const want = spec.formats.includes("png-alpha") ? "a 32-bit PNG (with alpha)" : "JPEG or 24-bit PNG (no alpha)";
    throw new PlayImageError("image_format_unsupported", `${label}: a Play ${imageType} must be ${want}`);
  }
  const { width, height } = image;
  const dims = `${width}x${height}`;
  if (spec.exact && (width !== spec.exact.width || height !== spec.exact.height)) {
    throw new PlayImageError("image_dimensions_invalid", `${label} is ${dims}; a Play ${imageType} must be ${spec.exact.width}x${spec.exact.height}`, { width, height });
  }
  if (spec.screenshot) {
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    if (short < spec.screenshot.minSide || long > spec.screenshot.maxSide || long > short * spec.screenshot.maxRatio) {
      throw new PlayImageError("image_dimensions_invalid",
        `${label} is ${dims}; Play screenshots need each side ${spec.screenshot.minSide}-${spec.screenshot.maxSide}px with the long side at most twice the short side`,
        { width, height });
    }
  }
  if (spec.square && (width !== height || width < spec.square.minSide)) {
    throw new PlayImageError("image_dimensions_invalid", `${label} is ${dims}; Wear OS screenshots must be 1:1 and at least ${spec.square.minSide}x${spec.square.minSide}`, { width, height });
  }
  return image;
}

export function checkImageCount(imageType: PlayImageType, count: number, label: string) {
  const spec = PLAY_IMAGE_SPECS[imageType];
  if (!spec) throw new PlayImageError("image_type_not_supported", `imageType ${imageType} is not supported yet`, { imageType });
  if (count < spec.min || count > spec.max) {
    throw new PlayImageError("image_count_invalid",
      `${label} has ${count} image(s); Play ${imageType} takes ${spec.min === spec.max ? spec.min : `${spec.min}-${spec.max}`}`,
      { count, min: spec.min, max: spec.max });
  }
}
