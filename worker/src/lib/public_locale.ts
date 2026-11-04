import type { Context } from "hono";
import { requestedLang } from "../routes/public_v2";

/** Page preference only: API clients retain requestedLang's existing contract. */
export function publicPageLanguage(c: Context<{ Bindings: Env }>): string | null {
  const query = typeof c.req.query === "function" ? c.req.query("lang") : undefined;
  const explicit = query || c.req.header("X-Hands-Lang") || c.req.header("X-Quiver-Lang");
  if (explicit) return explicit;
  const cookie = (c.req.header("cookie") ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith("hands_locale="))?.slice("hands_locale=".length);
  if (cookie === "en" || cookie === "zh-CN") return cookie;
  return requestedLang(c);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Same-origin links remain usable without JavaScript. Only page filters are kept. */
export function publicLanguageMenu(c: Context<{ Bindings: Env }>, current: string, pagePath?: string): string {
  let path = pagePath;
  if (!path) {
    try { path = new URL(c.req.url).pathname; } catch { path = "/"; }
  }
  // Prevent a path beginning with // from becoming a protocol-relative link.
  path = "/" + path.replace(/^\/+/, "");
  const link = (language: "en" | "zh-CN") => {
    const params = new URLSearchParams();
    for (const key of ["channel", "version_code"]) {
      const value = typeof c.req.query === "function" ? c.req.query(key) : undefined;
      if (value) params.set(key, value);
    }
    params.set("lang", language);
    return escapeAttribute(`${path}?${params}`);
  };
  const isZh = current.toLowerCase().startsWith("zh");
  return `<nav class="hands-language" style="margin:0 0 18px;font-size:14px" aria-label="${isZh ? "语言" : "Language"}"><a style="color:inherit" href="${link("en")}" data-hands-locale="en"${!isZh ? ' aria-current="page"' : ""}>English</a> · <a style="color:inherit" href="${link("zh-CN")}" data-hands-locale="zh-CN"${isZh ? ' aria-current="page"' : ""}>简体中文</a></nav>
<script>
  document.querySelectorAll('[data-hands-locale]').forEach(function (link) {
    link.addEventListener('click', function () {
      var locale = link.getAttribute('data-hands-locale');
      try { localStorage.setItem('hands:locale', locale); } catch (_) {}
      var host = location.hostname.toLowerCase();
      var domain = host === 'hands.build' || host.endsWith('.hands.build') ? '; Domain=.hands.build' : '';
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      try { document.cookie = 'hands_locale=' + locale + '; Path=/; Max-Age=31536000; SameSite=Lax' + domain + secure; } catch (_) {}
    });
  });
</script>`;
}
