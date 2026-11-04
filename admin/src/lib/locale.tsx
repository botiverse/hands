import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { currentLocale, persistLocale, type Locale } from "./localePreference";
export { currentLocale, persistLocale, preferredLocale, LOCALE_COOKIE, LOCALE_STORAGE } from "./localePreference";
export type { Locale } from "./localePreference";

type LocaleContextValue = { locale: Locale; setLocale: (locale: Locale) => void };
const LocaleContext = createContext<LocaleContextValue>({ locale: "en", setLocale: () => {} });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setCurrentLocale] = useState(currentLocale);
  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setCurrentLocale(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    // A preference may have changed on a different Hands subdomain or tab.
    const refresh = () => setCurrentLocale(currentLocale());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** Supply both translations at every call site; user-entered content stays unchanged. */
export function useText(): (english: string, chinese: string) => string {
  const { locale } = useLocale();
  return (english, chinese) => locale === "zh-CN" ? chinese : english;
}

export function LanguagePicker() {
  const { locale, setLocale } = useLocale();
  const t = useText();
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="sr-only">{t("Language", "语言")}</span>
      <select
        aria-label={t("Language", "语言")}
        value={locale}
        onChange={(event) => setLocale(event.currentTarget.value as Locale)}
        className="max-w-full rounded-md border border-line-muted bg-layer-panel px-2 py-2 text-foreground-strong"
      >
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </select>
    </label>
  );
}
