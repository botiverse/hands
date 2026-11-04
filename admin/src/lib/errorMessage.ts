import translations from "./apiError-zh.json";
import { currentLocale, type Locale } from "./localePreference";

const errorTranslations: Readonly<Record<string, string>> = translations;

/** Translate known Hands errors for display only; keep the Error and body intact. */
export function errorMessage(error: unknown, locale: Locale = currentLocale()): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (locale !== "zh-CN") {
    // The credentials form moved; keep the API response untouched while the
    // console points users to the current location.
    return raw === "no ASC credentials configured — add them in Settings → TestFlight first"
      ? "no ASC credentials configured — add them in Integrations → TestFlight first"
      : raw;
  }
  // The public invite endpoint is fetched directly and may return a small JSON
  // error body as text. Translate it only when there are no extra fields to lose.
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as Record<string, unknown>;
        if (typeof body.error === "string" && Object.hasOwn(errorTranslations, body.error)
          && Object.keys(body).every((key) => key === "error" || key === "code" || key === "failure_code")) {
          return errorMessage(Object.assign(new Error(body.error), { body }), locale);
        }
      }
    } catch { /* Preserve arbitrary or malformed provider text below. */ }
  }
  let translated = Object.hasOwn(errorTranslations, raw) ? errorTranslations[raw] : undefined;
  if (!translated && (raw === "Failed to fetch" || raw === "NetworkError when attempting to fetch resource.")) translated = "网络请求失败";
  const status = /^(?:upload failed\s+|attachment\s+|operation stream\s+|invite fetch failed\s+)(\d{3})$/.exec(raw);
  if (!translated && status) translated = `请求失败（HTTP ${status[1]}）`;
  const httpStatus = /^(\d{3})(?:\s+.*)?$/.exec(raw);
  if (!translated && httpStatus) translated = `请求失败（HTTP ${httpStatus[1]}）`;
  // Unknown text may be a provider response or user data; preserve it exactly.
  if (!translated) return raw;
  if (error && typeof error === "object" && "body" in error) {
    const body = (error as { body?: unknown }).body;
    if (body && typeof body === "object") {
      const detail = body as { code?: unknown; failure_code?: unknown };
      const codes = [detail.code, detail.failure_code].filter((code): code is string => typeof code === "string" && /^[A-Za-z0-9_.-]+$/.test(code));
      const missing = [...new Set(codes)].filter((code) => !translated!.includes(code));
      if (missing.length) translated += `（${missing.join(" / ")}）`;
    }
  }
  return translated;
}
