/**
 * Google Play store listing languages.
 *
 * Source: Play Console Help, "Translate and localize your app" -> "View list of
 * available languages" (support.google.com/googleplay/android-developer/answer/9844778,
 * read 2026-10-27). These are the exact tags Play Console and edits.listings use,
 * including the non-obvious ones (Hebrew is `iw-IL`, Indonesian `id`, Filipino
 * `fil`, Spanish (Latin America) `es-419`). Tags are case-sensitive here: Hands
 * sends exactly what Play lists, and suggests the canonical spelling otherwise.
 *
 * The list changes rarely; when Play adds a language, add it here (worker deploy).
 */
export const PLAY_LISTING_LANGUAGES: readonly string[] = [
  "af", "sq", "am", "ar", "hy-AM", "az-AZ", "bn-BD", "eu-ES", "be", "bg", "my-MM", "ca",
  "zh-HK", "zh-CN", "zh-TW", "hr", "cs-CZ", "da-DK", "nl-NL",
  "en-AU", "en-CA", "en-US", "en-GB", "en-IN", "en-SG", "en-ZA",
  "et", "fil", "fi-FI", "fr-CA", "fr-FR", "gl-ES", "ka-GE", "de-DE", "el-GR", "gu",
  "iw-IL", "hi-IN", "hu-HU", "is-IS", "id", "it-IT", "ja-JP", "kn-IN", "kk", "km-KH",
  "ko-KR", "ky-KG", "lo-LA", "lv", "lt", "mk-MK", "ms-MY", "ms", "ml-IN", "mr-IN",
  "mn-MN", "ne-NP", "no-NO", "fa", "fa-AE", "fa-AF", "fa-IR", "pl-PL", "pt-BR", "pt-PT",
  "pa", "ro", "rm", "ru-RU", "sr", "si-LK", "sk", "sl", "es-419", "es-ES", "es-US",
  "sw", "sv-SE", "ta-IN", "te-IN", "th", "tr-TR", "uk", "ur", "vi",
];

const BY_LOWER = new Map(PLAY_LISTING_LANGUAGES.map((tag) => [tag.toLowerCase(), tag]));

/**
 * Common short / script forms people type, mapped to the Play tag. Only used to
 * build a "did you mean" hint; Hands never rewrites a submitted language.
 */
const HINTS: Record<string, string> = {
  en: "en-US", zh: "zh-CN", "zh-hans": "zh-CN", "zh-hant": "zh-TW", ja: "ja-JP", ko: "ko-KR",
  de: "de-DE", fr: "fr-FR", es: "es-ES", pt: "pt-BR", it: "it-IT", ru: "ru-RU", he: "iw-IL",
  "he-il": "iw-IL", iw: "iw-IL", in: "id", tr: "tr-TR", nl: "nl-NL", pl: "pl-PL", sv: "sv-SE",
};

export function isPlayListingLanguage(tag: string): boolean {
  return BY_LOWER.get(tag.toLowerCase()) === tag;
}

/** The Play tag a near-miss most likely meant, or null. */
export function suggestPlayListingLanguage(tag: string): string | null {
  const lower = tag.toLowerCase();
  return BY_LOWER.get(lower) ?? HINTS[lower] ?? null;
}
