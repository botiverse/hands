// Legal pages have explicit language URLs; record that choice across Hands hosts.
const locale = document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
try { localStorage.setItem("hands:locale", locale); } catch { /* Cookies may still work. */ }
const host = location.hostname.toLowerCase();
const domain = host === "hands.build" || host.endsWith(".hands.build") ? "; Domain=.hands.build" : "";
const secure = location.protocol === "https:" ? "; Secure" : "";
document.cookie = `hands_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
