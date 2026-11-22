import type { Context } from "hono";
import { publicPageLanguage } from "./public_locale";
import { renderRaftNoticePage } from "./raft_page_style";

export type LoginErrorCopy = { en: string; zh: string };

/**
 * A login that cannot finish. Browsers (Accept: text/html) get a Raft Design
 * page in their language with a way back to the console; every other client
 * keeps the plain-text `text` it always received.
 */
export function loginErrorResponse(
  c: Context<{ Bindings: Env }>,
  status: number,
  text: string,
  message: LoginErrorCopy,
  options: { backToConsole?: boolean } = {},
): Response {
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/html")) {
    return new Response(text, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });
  }
  const zh = (publicPageLanguage(c) ?? "").toLowerCase().startsWith("zh");
  return new Response(
    renderRaftNoticePage({
      lang: zh ? "zh-CN" : "en",
      title: zh ? "登录没有完成" : "Couldn't sign in",
      message: zh ? message.zh : message.en,
      icon: "🔑",
      action: options.backToConsole === false ? undefined : { href: "/", label: zh ? "返回 Hands" : "Back to Hands" },
    }),
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
