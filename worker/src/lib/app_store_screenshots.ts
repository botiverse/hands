/**
 * App Store screenshot validation, before any App Store Connect call.
 *
 * Display types are Apple's ScreenshotDisplayType enum (App Store Connect API,
 * `appScreenshotSets.screenshotDisplayType`), copied verbatim. Apple has no
 * dedicated type for a dual-screen / "Duo" device; the 6.9" iPhone shares
 * APP_IPHONE_67 with the 6.7" one.
 *
 * Pixel sizes come from Apple's "Screenshot specifications" page (App Store Connect
 * Help). Only types with a size table here are accepted; an enum value without one
 * is refused as "not supported yet" rather than sent unchecked.
 *
 * Format: JPEG or PNG, RGB, flattened, no transparency (same page). A PNG with an
 * alpha channel (colour type 4/6) or a tRNS chunk is refused; flatten it first.
 * Count: 1-10 per set.
 */
import { md5 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { sniffImage } from "./play_images";

export const SCREENSHOT_DISPLAY_TYPES = [
  "APP_IPHONE_67",
  "APP_IPHONE_61",
  "APP_IPHONE_65",
  "APP_IPHONE_58",
  "APP_IPHONE_55",
  "APP_IPHONE_47",
  "APP_IPHONE_40",
  "APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129",
  "APP_IPAD_PRO_3GEN_11",
  "APP_IPAD_PRO_129",
  "APP_IPAD_105",
  "APP_IPAD_97",
  "APP_DESKTOP",
  "APP_WATCH_ULTRA",
  "APP_WATCH_SERIES_10",
  "APP_WATCH_SERIES_7",
  "APP_WATCH_SERIES_4",
  "APP_WATCH_SERIES_3",
  "APP_APPLE_TV",
  "APP_APPLE_VISION_PRO",
  "IMESSAGE_APP_IPHONE_67",
  "IMESSAGE_APP_IPHONE_61",
  "IMESSAGE_APP_IPHONE_65",
  "IMESSAGE_APP_IPHONE_58",
  "IMESSAGE_APP_IPHONE_55",
  "IMESSAGE_APP_IPHONE_47",
  "IMESSAGE_APP_IPHONE_40",
  "IMESSAGE_APP_IPAD_PRO_3GEN_129",
  "IMESSAGE_APP_IPAD_PRO_3GEN_11",
  "IMESSAGE_APP_IPAD_PRO_129",
  "IMESSAGE_APP_IPAD_105",
  "IMESSAGE_APP_IPAD_97",
] as const;
export type ScreenshotDisplayType = typeof SCREENSHOT_DISPLAY_TYPES[number];

/** Portrait sizes; the landscape (swapped) size is accepted too. */
const PORTRAIT_SIZES: Partial<Record<ScreenshotDisplayType, Array<[number, number]>>> = {
  // 6.9" (1320x2868, 1290x2796, 1260x2736) and 6.7" (1290x2796) share this type.
  APP_IPHONE_67: [[1320, 2868], [1290, 2796], [1260, 2736]],
  APP_IPHONE_65: [[1242, 2688], [1284, 2778]],
  // 6.3" and 6.1".
  APP_IPHONE_61: [[1206, 2622], [1179, 2556], [1170, 2532], [1125, 2436], [1080, 2340]],
  APP_IPHONE_55: [[1242, 2208]],
  // 13" iPad (2064x2752, 2048x2732).
  APP_IPAD_PRO_3GEN_129: [[2064, 2752], [2048, 2732]],
  APP_IPAD_PRO_3GEN_11: [[1488, 2266], [1668, 2420], [1668, 2388], [1640, 2360]],
  APP_IPAD_PRO_129: [[2048, 2732]],
};

export function allowedSizes(displayType: ScreenshotDisplayType): Array<{ width: number; height: number }> | null {
  const portrait = PORTRAIT_SIZES[displayType];
  if (!portrait) return null;
  return portrait.flatMap(([w, h]) => [{ width: w, height: h }, { width: h, height: w }]);
}

export const SCREENSHOT_MIN_PER_SET = 1;
export const SCREENSHOT_MAX_PER_SET = 10;
/** Per-file bound (Apple documents none; this keeps one request finite). */
export const SCREENSHOT_MAX_BYTES = 15 * 1024 * 1024;
/** Total image bytes in one push, same bound as the Play listing push. */
export const MAX_SCREENSHOT_PUSH_BYTES = 24 * 1024 * 1024;
export const MAX_SCREENSHOT_MULTIPART_BYTES = MAX_SCREENSHOT_PUSH_BYTES + 2 * 1024 * 1024;
const MAX_SETS = 60;

/** Locale code shape App Store Connect uses (en-US, zh-Hans, ja, ...). */
export const ASC_LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

export class ScreenshotInputError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function isScreenshotDisplayType(value: unknown): value is ScreenshotDisplayType {
  return typeof value === "string" && (SCREENSHOT_DISPLAY_TYPES as readonly string[]).includes(value);
}

export interface ScreenshotImage {
  part: string;
  bytes: Uint8Array;
  sha256: string;
  /** MD5 hex: what Apple stores as sourceFileChecksum and what idempotency compares. */
  md5: string;
  size_bytes: number;
  content_type: "image/png" | "image/jpeg";
  width: number;
  height: number;
  file_name: string;
}

export interface ScreenshotSetInput {
  locale: string;
  display_type: ScreenshotDisplayType;
  images: ScreenshotImage[];
}

export interface ScreenshotPush {
  mode: "dry_run" | "commit";
  sets: ScreenshotSetInput[];
}

export function md5Hex(bytes: Uint8Array): string {
  return bytesToHex(md5(bytes));
}

function checkImage(displayType: ScreenshotDisplayType, bytes: Uint8Array, where: string) {
  const sizes = allowedSizes(displayType);
  if (!sizes) {
    throw new ScreenshotInputError("SCREENSHOT_DISPLAY_TYPE_NOT_SUPPORTED",
      `${displayType} is an Apple display type Hands has no size table for yet`, { display_type: displayType });
  }
  if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
    throw new ScreenshotInputError("SCREENSHOT_TOO_LARGE", `${where} is ${bytes.byteLength} bytes; Hands accepts at most ${SCREENSHOT_MAX_BYTES} per screenshot`);
  }
  const image = sniffImage(bytes);
  if (!image || image.width === 0 || image.height === 0) {
    throw new ScreenshotInputError("SCREENSHOT_FORMAT_UNSUPPORTED", `${where} is not a PNG or JPEG image`);
  }
  if (image.alpha) {
    throw new ScreenshotInputError("SCREENSHOT_HAS_ALPHA",
      `${where} is a PNG with transparency (alpha channel or tRNS); App Store screenshots must be flattened RGB without transparency`);
  }
  if (!sizes.some((s) => s.width === image.width && s.height === image.height)) {
    throw new ScreenshotInputError("SCREENSHOT_DIMENSIONS_INVALID",
      `${where} is ${image.width}x${image.height}; ${displayType} accepts ${sizes.map((s) => `${s.width}x${s.height}`).join(", ")}`,
      { width: image.width, height: image.height, allowed: sizes });
  }
  return image;
}

/**
 * Validate a screenshot push completely before any Apple call: request shape, mode,
 * display types, locale shape, part integrity (sha256), format, alpha, pixel size,
 * count and byte bounds. Every uploaded part must be declared exactly once.
 */
export function normalizeScreenshotPush(body: unknown, parts: Map<string, Uint8Array>): ScreenshotPush {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ScreenshotInputError("INVALID_REQUEST", "request must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "sets") throw new ScreenshotInputError("INVALID_REQUEST", `unknown field ${key}`);
  }
  if (raw.mode !== "dry_run" && raw.mode !== "commit") {
    throw new ScreenshotInputError("MODE_REQUIRED", 'mode must be "dry_run" or "commit"; there is no default');
  }
  if (!Array.isArray(raw.sets) || raw.sets.length === 0 || raw.sets.length > MAX_SETS) {
    throw new ScreenshotInputError("INVALID_REQUEST", `sets must be a list of 1-${MAX_SETS} {locale, display_type, images}`);
  }
  const used = new Set<string>();
  const seen = new Set<string>();
  let total = 0;
  const sets = raw.sets.map((item: unknown): ScreenshotSetInput => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!row) throw new ScreenshotInputError("INVALID_REQUEST", "each set must be an object");
    for (const key of Object.keys(row)) {
      if (!["locale", "display_type", "images"].includes(key)) throw new ScreenshotInputError("INVALID_REQUEST", `unknown set field ${key}`);
    }
    const locale = typeof row.locale === "string" ? row.locale : "";
    if (!ASC_LOCALE_RE.test(locale)) {
      throw new ScreenshotInputError("INVALID_LOCALE", `locale ${JSON.stringify(row.locale)} is not an App Store Connect locale code (e.g. en-US, zh-Hans, ja)`);
    }
    if (!isScreenshotDisplayType(row.display_type)) {
      throw new ScreenshotInputError("INVALID_DISPLAY_TYPE",
        `display_type ${JSON.stringify(row.display_type)} is not an Apple ScreenshotDisplayType`,
        { allowed: SCREENSHOT_DISPLAY_TYPES });
    }
    const displayType = row.display_type;
    if (!allowedSizes(displayType)) {
      throw new ScreenshotInputError("SCREENSHOT_DISPLAY_TYPE_NOT_SUPPORTED",
        `${displayType} is an Apple display type Hands has no size table for yet`,
        { display_type: displayType, supported: SCREENSHOT_DISPLAY_TYPES.filter((t) => allowedSizes(t)) });
    }
    const label = `${locale} ${displayType}`;
    if (seen.has(label)) throw new ScreenshotInputError("INVALID_REQUEST", `${label} appears more than once`);
    seen.add(label);
    if (!Array.isArray(row.images) || row.images.length < SCREENSHOT_MIN_PER_SET || row.images.length > SCREENSHOT_MAX_PER_SET) {
      throw new ScreenshotInputError("SCREENSHOT_COUNT_INVALID",
        `${label}: images must list ${SCREENSHOT_MIN_PER_SET}-${SCREENSHOT_MAX_PER_SET} screenshots`,
        { count: Array.isArray(row.images) ? row.images.length : null });
    }
    const images = row.images.map((entry: unknown, index: number): ScreenshotImage => {
      const declaration = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
      const where = `${label} #${index + 1}`;
      const part = typeof declaration?.part === "string" ? declaration.part : "";
      const declaredSha = typeof declaration?.sha256 === "string" ? declaration.sha256 : "";
      if (!declaration || !part || !/^[0-9a-f]{64}$/.test(declaredSha)) {
        throw new ScreenshotInputError("INVALID_REQUEST", `${where}: needs part and a lowercase hex sha256`);
      }
      for (const key of Object.keys(declaration)) {
        if (key !== "part" && key !== "sha256") throw new ScreenshotInputError("INVALID_REQUEST", `${where}: unknown field ${key}`);
      }
      const bytes = parts.get(part);
      if (!bytes) throw new ScreenshotInputError("SCREENSHOT_PART_MISSING", `${where}: no uploaded file named ${part}`);
      if (used.has(part)) throw new ScreenshotInputError("INVALID_REQUEST", `${where}: file ${part} is declared twice`);
      used.add(part);
      if (bytesToHex(sha256(bytes)) !== declaredSha) {
        throw new ScreenshotInputError("SCREENSHOT_INTEGRITY_MISMATCH", `${where}: uploaded bytes do not match the declared sha256`);
      }
      total += bytes.byteLength;
      if (total > MAX_SCREENSHOT_PUSH_BYTES) {
        throw new ScreenshotInputError("SCREENSHOTS_REQUEST_TOO_LARGE",
          `screenshots in one push exceed ${MAX_SCREENSHOT_PUSH_BYTES} bytes; push fewer sets at a time`);
      }
      const image = checkImage(displayType, bytes, where);
      const ext = image.format === "png" ? "png" : "jpg";
      return {
        part,
        bytes,
        sha256: declaredSha,
        md5: md5Hex(bytes),
        size_bytes: bytes.byteLength,
        content_type: image.contentType,
        width: image.width,
        height: image.height,
        file_name: `${locale}_${displayType}_${String(index + 1).padStart(2, "0")}.${ext}`,
      };
    });
    return { locale, display_type: displayType, images };
  });
  const unused = [...parts.keys()].filter((part) => !used.has(part));
  if (unused.length > 0) {
    throw new ScreenshotInputError("INVALID_REQUEST", `uploaded files not declared in sets: ${unused.join(", ")}`);
  }
  return { mode: raw.mode, sets };
}

/** multipart/form-data with a `request` JSON part plus one file part per declared image. */
export async function readScreenshotMultipart(req: Request): Promise<{ body: unknown; parts: Map<string, Uint8Array> }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new ScreenshotInputError("MULTIPART_REQUIRED", "send multipart/form-data with a `request` JSON part and one file part per image");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SCREENSHOT_MULTIPART_BYTES) {
    throw new ScreenshotInputError("SCREENSHOTS_REQUEST_TOO_LARGE", `request exceeds ${MAX_SCREENSHOT_MULTIPART_BYTES} bytes; push fewer sets at a time`);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ScreenshotInputError("INVALID_REQUEST", "multipart body could not be parsed");
  }
  let body: unknown = null;
  const parts = new Map<string, Uint8Array>();
  for (const [name, entry] of form.entries()) {
    const value = entry as unknown as string | File;
    if (name === "request") {
      if (typeof value !== "string") throw new ScreenshotInputError("INVALID_REQUEST", "request part must be JSON text");
      try { body = JSON.parse(value); } catch { throw new ScreenshotInputError("INVALID_REQUEST", "request part is not valid JSON"); }
      continue;
    }
    if (typeof value === "string") throw new ScreenshotInputError("INVALID_REQUEST", `part ${name} must be a file`);
    if (parts.has(name)) throw new ScreenshotInputError("INVALID_REQUEST", `part ${name} appears more than once`);
    if (value.size > SCREENSHOT_MAX_BYTES) {
      throw new ScreenshotInputError("SCREENSHOT_TOO_LARGE", `part ${name} is ${value.size} bytes; Hands accepts at most ${SCREENSHOT_MAX_BYTES} per screenshot`);
    }
    parts.set(name, new Uint8Array(await value.arrayBuffer()));
  }
  return { body, parts };
}
