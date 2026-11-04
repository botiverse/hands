/** Language preferences are shared between hands.build and app.hands.build. */
export type Locale = "en" | "zh-CN";
export const LOCALE_COOKIE = "hands_locale";
export const LOCALE_STORAGE = "hands:locale";

export function preferredLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  }
  return "en";
}

function parseStored(value: string | null | undefined): Locale | null {
  return value === "en" || value === "zh-CN" ? value : null;
}

export function currentLocale(): Locale {
  if (typeof document !== "undefined") {
    try {
      const cookie = document.cookie.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
      const saved = parseStored(cookie?.slice(LOCALE_COOKIE.length + 1));
      if (saved) return saved;
    } catch {
      // Cookie access can be blocked independently of localStorage.
    }
  }
  if (typeof window !== "undefined") {
    try {
      const saved = parseStored(window.localStorage.getItem(LOCALE_STORAGE));
      if (saved) return saved;
    } catch {
      // Browser storage may be unavailable. The browser preference remains usable.
    }
  }
  return preferredLocale(typeof navigator === "undefined" ? ["en"] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function persistLocale(locale: Locale): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE, locale);
  } catch {
    // A functional cookie can still carry the choice when localStorage is blocked.
  }
  const host = window.location.hostname.toLowerCase();
  const domain = host === "hands.build" || host.endsWith(".hands.build") ? "; Domain=.hands.build" : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
  } catch {
    // The local preference still works if the browser blocks cookies.
  }
}
