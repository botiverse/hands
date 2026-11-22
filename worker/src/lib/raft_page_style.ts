/**
 * Raft Design System styles for Hands' public HTML pages (share, latest,
 * history, release notes). Token values come from @botiverse/raft-ui's
 * foundation and are inlined so each page stays a single response, including
 * inside an app's WebView.
 */

/** Space Grotesk for what people read, Space Mono for what machines write. */
export const RAFT_PAGE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400..700&family=Space+Mono&display=swap">`;

export const RAFT_PAGE_BASE_CSS = `
    :root {
      color-scheme: light dark;
      --sans: "Space Grotesk", Arial, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif;
      --mono: "Space Mono", ui-monospace, "SF Mono", Menlo, monospace;
      --ink: oklch(0.1813 0.005 17.62);
      --canvas: oklch(1 0 0);
      --card: oklch(1 0 0);
      --fg: var(--ink);
      --fg-muted: oklch(0.1813 0.005 17.62 / 0.678);
      --fg-hint: oklch(0.1813 0.005 17.62 / 0.62);
      --fg-link: oklch(0.4327 0.1282 256.54);
      --fill-muted: oklch(0.9642 0 0);
      --line-strong: var(--ink);
      --line-hairline: oklch(0.1813 0.005 17.62 / 0.149);
      --line-field: var(--ink);
      --attention: oklch(0.7999 0.1308 354.26);
      --attention-hover: color-mix(in srgb, oklch(0.7999 0.1308 354.26) 90%, oklch(0.1813 0.005 17.62));
      --success: oklch(0.8272 0.1354 130.07);
      --info-soft: oklch(0.9452 0.0326 226.3);
      --info-strong: oklch(0.348 0.06 219.02);
      --warning: oklch(0.7855 0.1227 50.11);
      --warning-strong: oklch(0.361 0.076 55.55);
      --danger-strong: oklch(0.5154 0.1715 32.56);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: oklch(0.2213 0.0038 106.71);
        --card: oklch(0.2596 0.0037 106.65);
        --fg: oklch(0.9211 0.004 106.48);
        --fg-muted: oklch(0.8195 0.0041 106.49);
        --fg-hint: oklch(0.8195 0.0041 106.49 / 0.8);
        --fg-link: oklch(0.8 0.1 250);
        --fill-muted: oklch(0.3161 0.0052 106.7);
        --line-strong: oklch(0.9211 0.004 106.48);
        --line-hairline: oklch(0.9843 0.004 106.47 / 0.102);
        --line-field: oklch(0.9843 0.004 106.47 / 0.259);
        --info-soft: oklch(0.452 0.0862 225.67 / 0.18);
        --info-strong: oklch(0.8 0.1 220);
        --warning-strong: oklch(0.82 0.12 55);
        --danger-strong: oklch(0.8 0.12 30);
      }
    }
    html, body { background: var(--canvas); }
    body { margin: 0; min-height: 100vh; color: var(--fg); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
    a { color: var(--fg-link); }
    .hands-language { display: inline-flex; gap: 2px; padding: 2px; margin: 0 0 20px !important; border: 1px solid var(--line-hairline); border-radius: 8px; font-size: 0 !important; }
    .hands-language a { color: var(--fg-muted) !important; text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 13px; line-height: 18px; font-weight: 500; }
    .hands-language a[aria-current="page"] { color: var(--fg) !important; background: var(--fill-muted); }
    h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -0.01em; }
    .sub { color: var(--fg-muted); font-size: 13px; line-height: 18px; margin: 2px 0 0; }
    .mono { font-family: var(--mono); }
    .badge { display: inline-block; vertical-align: middle; border-radius: 4px; padding: 2px 6px; font-size: 11px; line-height: 13px; font-weight: 600; letter-spacing: 0; border: 1px solid transparent; }
    .badge.you { background: var(--success); color: var(--ink); border-color: var(--ink); }
    .badge.latest { background: var(--info-soft); color: var(--info-strong); }
    .badge.draft { background: var(--warning); color: var(--ink); border-color: var(--ink); }
    .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; box-sizing: border-box; border: 1px solid var(--ink); border-radius: 8px; background: var(--attention); color: var(--ink); font: 600 15px/20px var(--sans); text-decoration: none; cursor: pointer; }
    .button:hover { background: var(--attention-hover); }
    .text-link { color: var(--fg); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-hairline); }
    .apphead { display: flex; align-items: center; gap: 14px; }
    .apphead img { width: 56px; height: 56px; border-radius: 12px; border: 1px solid var(--line-hairline); flex: none; }
    dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 24px 0; padding: 14px 0; border-top: 1px solid var(--line-hairline); border-bottom: 1px solid var(--line-hairline); font-size: 14px; line-height: 20px; }
    dl.facts dt { color: var(--fg-muted); }
    dl.facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
    dl.facts dd.mono { font-size: 12px; line-height: 20px; font-weight: 400; }
    .notes { font-size: 15px; line-height: 22px; color: var(--fg); overflow-wrap: anywhere; }
    .notes.muted { color: var(--fg-hint); }
    .notes p { margin: 12px 0 4px; }
    .notes p:first-child { margin-top: 0; }
    .notes strong { font-weight: 700; }
    .notes ul { margin: 4px 0 0; padding-left: 18px; list-style: disc; }
    .notes li { margin: 6px 0; }
    .notes li::marker { color: var(--fg-hint); }
    .notes code { font-family: var(--mono); font-size: 0.86em; background: var(--fill-muted); border-radius: 4px; padding: 1px 4px; }
    .notes a { color: inherit; }
`;

/** Lucide outline icons (the set Raft UI uses), inlined so pages stay one response. */
const RAFT_ICON_PATHS = {
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
} as const;

export type RaftIconName = keyof typeof RAFT_ICON_PATHS;

export function raftIcon(name: RaftIconName, size = 22): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RAFT_ICON_PATHS[name]}</svg>`;
}

function escapeNoticeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type RaftNoticePage = {
  /** The page's `lang` attribute. */
  lang: string;
  title: string;
  message?: string;
  /** Shown in a muted tile above the title. */
  icon: RaftIconName;
  action?: { href: string; label: string } | undefined;
  /** Pre-rendered language switch (publicLanguageMenu), or "" for none. */
  languageMenu?: string;
};

/**
 * A centred, single-message page in Raft Design: errors and dead ends on
 * public links and login, so a person sees what happened instead of a line of
 * plain text. Title, message and action are escaped here.
 */
export function renderRaftNoticePage(page: RaftNoticePage): string {
  const action = page.action
    ? `<a class="button" href="${escapeNoticeHtml(page.action.href)}">${escapeNoticeHtml(page.action.label)}</a>`
    : "";
  return `<!doctype html>
<html lang="${escapeNoticeHtml(page.lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeNoticeHtml(page.title)}</title>
  ${RAFT_PAGE_FONTS}
  <style>${RAFT_PAGE_BASE_CSS}
    body { display: grid; place-items: center; }
    main { width: min(360px, calc(100vw - 32px)); padding: 32px 0; text-align: center; }
    .icon { width: 44px; height: 44px; margin: 16px auto; border-radius: 10px; display: grid; place-items: center; background: var(--fill-muted); color: var(--fg); }
    p { margin: 6px 0 0; color: var(--fg-muted); font-size: 15px; line-height: 22px; }
    main > a.button { margin-top: 20px; }
  </style>
</head>
<body>
  <main>
    ${page.languageMenu ?? ""}
    <div class="icon">${raftIcon(page.icon)}</div>
    <h1>${escapeNoticeHtml(page.title)}</h1>
    ${page.message ? `<p>${escapeNoticeHtml(page.message)}</p>` : ""}
    ${action}
  </main>
</body>
</html>`;
}
